"""
Analysis Subagent — reads downloaded training results and produces a written report.
Spawned by the Orchestrator after results are downloaded locally.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import anthropic

from base_agent import run_agent_loop

_SYSTEM = """You are the Analysis Agent for the CS659 CNN plant-classification project.
Your job is to read the downloaded training results and produce a clear, insightful report.

You have tools to read:
- read_metrics_csv:          Per-epoch accuracy, F1, precision, recall, ROC AUC
- read_classification_report: Per-class precision/recall/F1 on the test set
- read_hyperparameters:      The exact hyperparameters used
- read_done_info:            Training duration and exit status

After reading the data, write a comprehensive analysis covering:
1. Training convergence (did loss/accuracy plateau? early stopping triggered?)
2. Final test metrics (accuracy, F1 macro, ROC AUC)
3. Worst-performing classes (from the classification report)
4. Overfitting signs (train vs val gap)
5. Hyperparameter observations
6. Concrete recommendations for the next run

Save your full analysis to a markdown file with save_analysis_report.
"""

_TOOLS = [
    {
        "name": "read_metrics_csv",
        "description": "Read the per-epoch metrics CSV. Returns CSV text with columns: epoch, train_accuracy, val_accuracy, train_f1_macro, val_f1_macro, etc.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "read_classification_report",
        "description": "Read the test set classification report (per-class precision/recall/F1). Returns text.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "read_hyperparameters",
        "description": "Read the hyperparameters_snapshot.json from the results directory. Returns JSON string.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "read_done_info",
        "description": "Read the DONE sentinel JSON (training duration, exit status).",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "save_analysis_report",
        "description": "Save the analysis as a markdown file in the results directory.",
        "input_schema": {
            "type": "object",
            "properties": {
                "content": {"type": "string", "description": "Full markdown content of the report"},
            },
            "required": ["content"],
        },
    },
]

# Resolution order for the results root:
#   1. CS659_RESULTS_DIR env var (set by the pod orchestrator before spawning us)
#   2. /workspace/results (pod-side default — analysis runs ON the pod)
#   3. <repo_root>/results (laptop-side default for ad-hoc local testing)
#
# The hardcoded `Path(__file__).parent.parent.parent / "results"` previously
# used here resolved to `/results` on the pod (since /workspace/agents/
# analysis_agent.py has only two parent dirs before /), which silently broke
# every pod-side analysis run — the agent reported "no results directory found"
# and analysis_report.md never made it into the Release.
def _resolve_results_root() -> Path:
    env_dir = os.environ.get("CS659_RESULTS_DIR")
    if env_dir:
        return Path(env_dir)
    pod_dir = Path("/workspace/results")
    if pod_dir.exists():
        return pod_dir
    return Path(__file__).resolve().parent.parent.parent / "results"


def _latest_run_dir() -> Path | None:
    root = _resolve_results_root()
    if not root.exists():
        return None
    # Try direct read of the root first — pod-side training writes
    # metrics/plots/snapshots straight into /workspace/results/, not into a
    # timestamped subdir. If we find any of the canonical files at that level,
    # treat the root itself as the run dir.
    canonical = (
        "hyperparameters_snapshot.json",
        "metrics_train_val_test.json",
        "split_summary.json",
        "plant_classifier_deep_learning.tflite",
    )
    if any((root / n).exists() for n in canonical):
        return root
    # Otherwise fall back to the latest dated subdir (laptop-side layout).
    dirs = sorted(
        (d for d in root.iterdir() if d.is_dir()),
        key=lambda d: d.name,
        reverse=True,
    )
    return dirs[0] if dirs else None


def _find_file(run_dir: Path, *names: str) -> Path | None:
    """Search run_dir and its known per-split subdirs for any of the given filenames.

    Layouts seen in the wild (oldest → newest):
      run_dir/<file>                          flat
      run_dir/single_split/<file>             k_folds=1 wrapper layout
      run_dir/fold_*/<file>                   k-fold cross-validation layout
      run_dir/split_metrics/<split>/<file>    per-split metrics directory
                                               (split ∈ train, validation, test)

    The split_metrics/test/ branch is what trips analyses today: training
    writes classification_report.txt there but the agent used to only look
    at single_split/, returning "not found" and forcing the LLM to write
    a fact-free analysis.
    """
    candidates = [run_dir]
    candidates += list(run_dir.glob("single_split"))
    candidates += list(run_dir.glob("fold_*"))
    split_metrics = run_dir / "split_metrics"
    if split_metrics.exists():
        # Prefer test → val → train when the same filename exists in multiple
        # per-split subdirs — the test split is what actually matters for
        # generalization analysis.
        for sub in ("test", "validation", "train"):
            d = split_metrics / sub
            if d.exists():
                candidates.append(d)
    for search_dir in candidates:
        for name in names:
            p = search_dir / name
            if p.exists():
                return p
    return None


def _execute_tool(name: str, inputs: dict) -> str:
    run_dir = _latest_run_dir()
    if run_dir is None:
        return "Error: no results directory found. Run training first."

    if name == "read_metrics_csv":
        # training_wrapper.py writes the per-epoch CSV under several legacy
        # names depending on git history; prefer the modern name and fall
        # back. If no CSV exists at all, fall back to the rich JSON summary
        # at results-dir root — it has train/val/test accuracy, F1, ROC AUC,
        # and is sufficient to diagnose overfit vs underfit by itself.
        for fname in ("metrics_metrics_per_epoch.csv", "metrics_per_epoch.csv", "metrics_train_val_test.csv"):
            p = _find_file(run_dir, fname)
            if p:
                return p.read_text()
        json_p = _find_file(run_dir, "metrics_train_val_test.json")
        if json_p:
            return ("[no per-epoch CSV found — returning final-split JSON summary instead]\n"
                    + json_p.read_text())
        return "No per-epoch CSV or final-split JSON found in run_dir."

    if name == "read_classification_report":
        # Modern wrapper names first (metrics_classification_report.txt and
        # split_metrics/test/classification_report.txt), legacy last.
        for fname in (
            "metrics_classification_report.txt",
            "classification_report.txt",
            "test_classification_report.txt",
        ):
            p = _find_file(run_dir, fname)
            if p:
                return p.read_text()
        return "No classification report found in run_dir."

    if name == "read_hyperparameters":
        p = _find_file(run_dir, "hyperparameters_snapshot.json")
        return p.read_text() if p else "hyperparameters_snapshot.json not found."

    if name == "read_done_info":
        # On the pod, training_wrapper writes DONE at /workspace/DONE — one
        # level ABOVE results_dir (/workspace/results). The previous code
        # used run_dir.parent.parent, which on the pod resolves to / and on
        # the laptop resolves to the repo root — both wrong. The result
        # was every analysis run reporting "DONE file not found locally"
        # and the LLM concluding training had crashed mid-run, even on
        # successful runs that shipped a fully populated Release.
        for candidate in (
            run_dir.parent / "DONE",   # pod-side: /workspace/DONE
            run_dir        / "DONE",   # laptop fallback if synced into run_dir
            run_dir.parent.parent / "DONE",   # legacy path, kept just in case
        ):
            if candidate.exists():
                return candidate.read_text()
        return "DONE file not found locally."

    if name == "save_analysis_report":
        out = run_dir / "analysis_report.md"
        out.write_text(inputs["content"])
        return f"Report saved to {out}"

    raise ValueError(f"Unknown tool: {name}")


def run(client: anthropic.Anthropic) -> str:
    """Run the analysis agent and return its report."""
    return run_agent_loop(
        client=client,
        agent_name="AnalysisAgent",
        system_prompt=_SYSTEM,
        tools=_TOOLS,
        initial_message=(
            "Read all available training results from the local results/ directory "
            "and produce a complete analysis report. Save it with save_analysis_report."
        ),
        tool_executor=_execute_tool,
        model="claude-opus-4-7",   # deep analysis → most capable model
        max_iterations=15,
    )
