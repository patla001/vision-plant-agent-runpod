"""AI-driven hyperparameter suggestion.

Single-turn Claude call (no agent loop) that reads a training run's metrics
and current hyperparameters, diagnoses overfit/underfit/well-fit, and
suggests revised hyperparameters that would likely improve a re-run.

Used by pod_orchestrator's `suggest_hyperparameters` tool. The structured
output is enforced via tool_use — the model is forced to call our local
`submit_suggestion` tool whose input_schema is the response shape we want.

Output JSON shape (saved to suggested_hyperparameters.json in results_dir):
  {
    "diagnosis":         "overfitting" | "underfitting" | "well_fit",
    "reasoning":         "2-3 sentences why",
    "suggested_hyperparameters": {  // only keys to change; merged with current
       "learning_rate":         0.0003,
       "dropout":               0.4,
       ...
    },
    "expected_improvement": "1 sentence",
    "based_on_run":      run_tag,
    "produced_at":       ISO-8601 UTC,
    "current_hyperparameters": { ...full current dict for reference... }
  }
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import anthropic


_SYSTEM = """You are an ML training expert reviewing a CNN training run.

Given:
  - The full metrics history (per-epoch CSV: train/val accuracy, F1, loss, ...)
  - The final test classification report
  - The current hyperparameters used for this run

Decide whether the model is OVERFITTING, UNDERFITTING, or WELL-FIT, and
recommend revised hyperparameters that would likely produce a better model
on a re-run. Be conservative — change at most 3 hyperparameters per
suggestion, and prefer small adjustments over large ones.

Common signals:
  - Overfitting:  train accuracy >> val accuracy, val accuracy plateaus or
                  drops late, large train/val gap. Suggest: increase dropout,
                  reduce epochs, add early stopping, lower learning rate.
  - Underfitting: both train and val accuracy low, both still climbing at
                  the end. Suggest: increase epochs, increase learning rate
                  (cautiously), reduce dropout.
  - Well-fit:     train and val close, both plateau, test ~ val. Suggest:
                  no change, OR small lr decrease for marginal gains.

Tunable hyperparameters (deep_learning section only):
  epochs, learning_rate, dropout, early_stopping_patience.

DO NOT suggest changing batch_size (memory-bound), img_size (architecture-bound),
or color_correct (orthogonal user choice).

Always call the `submit_suggestion` tool with your structured output. Do not
emit free text outside the tool call.
"""


def _read_first_lines(p: Path, n: int = 80) -> str:
    if not p.exists():
        return f"[file not found: {p.name}]"
    text = p.read_text(errors="replace")
    lines = text.splitlines()
    if len(lines) <= n:
        return text
    head = "\n".join(lines[:8])
    tail = "\n".join(lines[-(n - 8):])
    return f"{head}\n... [truncated {len(lines) - n} lines] ...\n{tail}"


def _truncate(s: str, maxlen: int = 6000) -> str:
    return s if len(s) <= maxlen else s[:maxlen] + f"\n... [truncated {len(s) - maxlen} chars] ..."


_TOOL = {
    "name": "submit_suggestion",
    "description": "Submit your hyperparameter suggestion as structured JSON.",
    "input_schema": {
        "type": "object",
        "properties": {
            "diagnosis": {
                "type": "string",
                "enum": ["overfitting", "underfitting", "well_fit"],
            },
            "reasoning": {
                "type": "string",
                "description": "2-3 sentences explaining the diagnosis based on the metrics.",
            },
            "suggested_hyperparameters": {
                "type": "object",
                "description": (
                    "Dict mapping deep_learning hyperparameter names to new values. "
                    "Include ONLY keys you want to change. Empty object means no change."
                ),
                "additionalProperties": True,
            },
            "expected_improvement": {
                "type": "string",
                "description": "One sentence describing what would improve and roughly by how much.",
            },
        },
        "required": [
            "diagnosis", "reasoning", "suggested_hyperparameters", "expected_improvement",
        ],
    },
}


def suggest(
    client: anthropic.Anthropic,
    results_dir: Path,
    current_hyperparameters: dict,
    run_tag: str,
    model: str = "claude-opus-4-7",
) -> dict:
    """Returns the structured suggestion dict (also written to results_dir).

    File-discovery strategy: training_wrapper.py writes results into a flat
    /workspace/results/ tree on the pod with these names today —

      metrics_train_val_test.json                       (split summary)
      single_split/metrics_metrics_per_epoch.csv        (per-epoch CSV)
      single_split/metrics_classification_report.txt    (per-class P/R/F1)
      split_metrics/test/classification_report.txt      (also per-class)

    Older layouts (and earlier code in this file) looked for
    metrics_train_val_test.csv and test_classification_report.txt — both
    of which don't exist anymore. The 2026-05-05 17:40 run silently
    diagnosed "underfitting" with the reasoning "no metrics CSV or test
    report was provided" because of this mismatch. We now rglob under
    multiple historical names AND fall back to the rich
    metrics_train_val_test.json so the model always has *something* to
    reason about.
    """
    # Per-epoch CSV — try both modern and legacy names
    csv_candidates = (
        list(results_dir.rglob("metrics_metrics_per_epoch.csv"))
        + list(results_dir.rglob("metrics_per_epoch.csv"))
        + list(results_dir.rglob("metrics_train_val_test.csv"))
    )
    csv_text = _read_first_lines(csv_candidates[0]) if csv_candidates else "[no per-epoch CSV found]"

    # Final-split summary JSON — always present at the results-dir root.
    summary_path = results_dir / "metrics_train_val_test.json"
    summary_text = (
        _truncate(summary_path.read_text(errors="replace"), 3000)
        if summary_path.exists() else "[no summary JSON found]"
    )

    # Classification report — modern names first, legacy last.
    report_candidates = (
        list(results_dir.rglob("metrics_classification_report.txt"))
        + list((results_dir / "split_metrics" / "test").rglob("classification_report.txt"))
        + list(results_dir.rglob("classification_report.txt"))
        + list(results_dir.rglob("test_classification_report.txt"))
    )
    report_text = _truncate(
        report_candidates[0].read_text(errors="replace") if report_candidates else "[no classification report found]",
        4000,
    )

    # Make the user message compact but informative. Order matters: summary
    # JSON is the most compact and reliable signal of overfit vs underfit
    # so we put it first, then the per-epoch CSV (trajectory), then the
    # classification report (per-class).
    user_msg = (
        "FINAL METRICS SUMMARY (train/val/test, JSON):\n"
        f"```json\n{summary_text}\n```\n\n"
        "PER-EPOCH METRICS (CSV):\n"
        f"```csv\n{csv_text}\n```\n\n"
        "TEST CLASSIFICATION REPORT (head):\n"
        f"```\n{report_text}\n```\n\n"
        "CURRENT HYPERPARAMETERS (deep_learning section):\n"
        f"```json\n{json.dumps(current_hyperparameters, indent=2)}\n```\n\n"
        "Diagnose, reason, and call submit_suggestion."
    )

    response = client.messages.create(
        model=model,
        max_tokens=2000,
        system=[{"type": "text", "text": _SYSTEM, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": user_msg}],
        tools=[_TOOL],
        tool_choice={"type": "tool", "name": "submit_suggestion"},
    )

    # Extract the tool_use block — Claude is forced to call our tool, so it's there.
    tool_block = next((b for b in response.content if b.type == "tool_use"), None)
    if tool_block is None:
        raise RuntimeError("submit_suggestion tool was not called by the model.")

    payload = dict(tool_block.input)
    # Annotate provenance for downstream readers (dashboard, future runs)
    payload["based_on_run"]            = run_tag
    payload["produced_at"]             = datetime.now(timezone.utc).isoformat()
    payload["current_hyperparameters"] = current_hyperparameters

    out_path = results_dir / "suggested_hyperparameters.json"
    out_path.write_text(json.dumps(payload, indent=2) + "\n")

    return payload
