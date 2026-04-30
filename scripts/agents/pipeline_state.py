"""
Writes pipeline state to results/pipeline_state.json so the Next.js dashboard
can read current progress without polling the Python process directly.
"""
from __future__ import annotations

import json
import os
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
