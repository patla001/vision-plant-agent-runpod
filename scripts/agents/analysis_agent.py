"""
Analysis Subagent — reads downloaded training results and produces a written report.
Spawned by the Orchestrator after results are downloaded locally.
"""
from __future__ import annotations

import json
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

RESULTS_ROOT = Path(__file__).parent.parent.parent / "results"


def _latest_run_dir() -> Path | None:
    if not RESULTS_ROOT.exists():
        return None
    dirs = sorted(
        (d for d in RESULTS_ROOT.iterdir() if d.is_dir()),
        key=lambda d: d.name,
        reverse=True,
    )
    return dirs[0] if dirs else None


def _find_file(run_dir: Path, *names: str) -> Path | None:
    """Search run_dir and its single_split/ subdirectory for any of the given filenames."""
    candidates = [run_dir] + list(run_dir.glob("single_split")) + list(run_dir.glob("fold_*"))
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
        p = _find_file(run_dir, "metrics_train_val_test.csv")
        return p.read_text() if p else "metrics_train_val_test.csv not found."

    if name == "read_classification_report":
        p = _find_file(run_dir, "test_classification_report.txt")
        return p.read_text() if p else "test_classification_report.txt not found."

    if name == "read_hyperparameters":
        p = _find_file(run_dir, "hyperparameters_snapshot.json")
        return p.read_text() if p else "hyperparameters_snapshot.json not found."

    if name == "read_done_info":
        # The DONE file was downloaded as part of the results rsync
        p = run_dir.parent.parent / "DONE"   # /workspace/DONE landed at results/DONE
        if not p.exists():
            p = run_dir / "DONE"
        return p.read_text() if p.exists() else "DONE file not found locally."

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
