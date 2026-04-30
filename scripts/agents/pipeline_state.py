"""
Writes pipeline state to results/pipeline_state.json so the Next.js dashboard
can read current progress without polling the Python process directly.
"""
from __future__ import annotations

import json
import os
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path

RESULTS_ROOT = Path(__file__).parent.parent.parent / "results"
STATE_FILE   = RESULTS_ROOT / "pipeline_state.json"


def write_state(status: str, step: str, **extra: object) -> None:
    """Merge status + step into pipeline_state.json atomically."""
    RESULTS_ROOT.mkdir(parents=True, exist_ok=True)

    existing: dict = {}
    if STATE_FILE.exists():
        try:
            existing = json.loads(STATE_FILE.read_text())
        except Exception:
            existing = {}

    if "started_at" not in existing:
        existing["started_at"] = datetime.now(timezone.utc).isoformat()

    existing.update({
        "status":       status,
        "current_step": step,
        "updated_at":   datetime.now(timezone.utc).isoformat(),
        **extra,
    })

    if status in ("done", "failed") and "finished_at" not in existing:
        existing["finished_at"] = datetime.now(timezone.utc).isoformat()

    # Write atomically via temp file
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(existing, indent=2) + "\n")
    tmp.replace(STATE_FILE)


def write_error(message: str, exception: BaseException | None = None) -> None:
    """
    Write a 'failed' state with rich error info: exception class, message,
    full traceback. The dashboard renders these in the failed-state UI.
    Also prints the traceback to stderr so it lands in pipeline.log.
    """
    extra: dict = {"error_message": str(exception) if exception else message}
    if exception is not None:
        extra["error_type"]      = type(exception).__name__
        extra["error_traceback"] = traceback.format_exc()
        # Echo to stderr so the formatted traceback appears in pipeline.log
        print("=" * 60, file=sys.stderr, flush=True)
        print(f"PIPELINE ERROR: {extra['error_type']}: {extra['error_message']}",
              file=sys.stderr, flush=True)
        print(extra["error_traceback"], file=sys.stderr, flush=True)
        print("=" * 60, file=sys.stderr, flush=True)
    write_state("failed", message, **extra)
