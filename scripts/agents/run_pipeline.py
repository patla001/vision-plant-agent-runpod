#!/usr/bin/env python3
"""
Entry point for the CS659 multi-agent CNN training pipeline.

Architecture:
  OrchestratorAgent (claude-opus-4-7)
    ├── tool: check_training_status → spawns MonitorAgent (claude-haiku-4-5)
    └── tool: analyze_results      → spawns AnalysisAgent (claude-opus-4-7)

Usage:
    cd scripts/
    python agents/run_pipeline.py

Requires in .env (repo root):
    RUNPOD_API_KEY=...
    ANTHROPIC_API_KEY=...
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

from dotenv import load_dotenv

# Load .env from repo root
load_dotenv(Path(__file__).parent.parent.parent / ".env")

# Verify required keys
missing = [k for k in ("RUNPOD_API_KEY", "ANTHROPIC_API_KEY") if not os.environ.get(k)]
if missing:
    print(f"Error: missing environment variables: {', '.join(missing)}")
    print("Add them to .env in the repo root (see .env.example).")
    sys.exit(1)

import anthropic

# Ensure agents/ directory is on the path
sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent))

import orchestrator
from pipeline_state import write_state, write_error


VALID_COLOR_CORRECT = ("none", "gray_world", "max_rgb")


def main() -> None:
    client = anthropic.Anthropic()

    # Per-run color-correction override, set by /api/pipeline/start when the
    # user picks a value in the dashboard. Empty/missing → JSON default applies.
    cc = os.environ.get("PIPELINE_COLOR_CORRECT") or None
    if cc and cc not in VALID_COLOR_CORRECT:
        print(f"Error: PIPELINE_COLOR_CORRECT={cc!r} not in {VALID_COLOR_CORRECT}")
        sys.exit(1)

    print("=" * 60)
    print("CS659 Multi-Agent CNN Training Pipeline")
    print("Models: Orchestrator=claude-opus-4-7 | Monitor=claude-haiku-4-5 | Analysis=claude-opus-4-7")
    if cc:
        print(f"Color correction override: {cc}")
    print("=" * 60)

    write_state("running", "Orchestrator initializing...", pid=os.getpid())

    try:
        summary = orchestrator.run(client, color_correct=cc)
        write_state("done", "Pipeline complete.", summary=summary)
        print("\n" + "=" * 60)
        print("PIPELINE COMPLETE")
        print("=" * 60)
        print(summary)
    except Exception as exc:
        write_error(f"Pipeline failed: {exc}", exception=exc)
        raise


if __name__ == "__main__":
    main()
