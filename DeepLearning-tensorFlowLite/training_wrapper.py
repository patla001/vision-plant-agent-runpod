#!/usr/bin/env python3
"""
CNN training orchestrator for the RunPod pod.
Runs train_export_tflite.py with all hyperparameters from model_hyperparameters.json,
copies outputs to --result_dir, and writes a DONE sentinel file on completion.

Usage (called by pod_setup.sh inside screen):
    python training_wrapper.py \
        --data_dir /workspace/plantnet_flat \
        --result_dir /workspace/results \
        --done_file /workspace/DONE
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


def _log(msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    print(f"[{ts}] {msg}", flush=True)


def _fmt(seconds: float) -> str:
    h, r = divmod(int(seconds), 3600)
    m, s = divmod(r, 60)
    return f"{h}h {m}m {s}s" if h else f"{m}m {s}s"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data_dir",      required=True, type=Path)
    parser.add_argument("--result_dir",    required=True, type=Path)
    parser.add_argument("--done_file",     required=True, type=Path)
    parser.add_argument("--config",        default=Path(__file__).parent / "model_hyperparameters.json", type=Path)
    # Per-run override for color correction. Empty/missing → fall back to JSON default.
    # Valid values come from color_correction.COLOR_METHODS = ("none", "gray_world", "max_rgb").
    parser.add_argument("--color_correct", default=None, choices=[None, "none", "gray_world", "max_rgb"])
    args = parser.parse_args()

    args.result_dir.mkdir(parents=True, exist_ok=True)

    # Load hyperparameters so we can log what we're running
    cfg = json.loads(args.config.read_text())
    dl  = cfg.get("deep_learning", {})

    _log("=== CNN Training Wrapper ===")
    _log(f"Data dir : {args.data_dir}")
    _log(f"Result dir: {args.result_dir}")
    _log(f"Hyperparameters (deep_learning section):")
    for k, v in dl.items():
        _log(f"  {k}: {v}")
    if args.color_correct:
        _log(f"  color_correct override: {args.color_correct}")

    script = Path(__file__).parent / "train_export_tflite.py"

    # Write the .tflite into result_dir so it gets picked up by the orchestrator's
    # rsync of /workspace/results/. Default --out_tflite is the cwd-relative
    # plant_classifier_deep_learning.tflite which would land in the repo dir
    # and never reach the dashboard.
    tflite_out = args.result_dir / "plant_classifier_deep_learning.tflite"

    cmd = [
        sys.executable, str(script),
        "--data_dir",   str(args.data_dir),
        "--log_dir",    str(args.result_dir),
        "--out_tflite", str(tflite_out),
        # Pass --config EXPLICITLY. train_export_tflite.py's --config default
        # is None, which silently leaves file_defaults={} and falls through
        # to every hyperparameter's hardcoded fallback (epochs=25, lr=1e-4,
        # dropout=0.2, …). pod_setup.sh's hyperparameter override step writes
        # the manual / AI-suggested values into model_hyperparameters.json,
        # but if we don't pass --config, train_export_tflite.py never reads
        # that file. Result: every "manual" or "AI" run silently used defaults.
        "--config",     str(args.config),
    ]
    if args.color_correct:
        cmd += ["--color_correct", args.color_correct]

    _log(f"Running: {' '.join(cmd)}")
    start = time.time()

    result = subprocess.run(cmd, check=False)

    elapsed = time.time() - start
    _log(f"Training finished in {_fmt(elapsed)} — exit code {result.returncode}")

    if result.returncode != 0:
        _log("ERROR: training script exited with non-zero code. Check training.log.")
        # Still write DONE so the monitor can detect completion and download logs
        args.done_file.write_text(json.dumps({
            "status": "error",
            "exit_code": result.returncode,
            "elapsed_seconds": elapsed,
            "finished_at": datetime.now(timezone.utc).isoformat(),
        }) + "\n")
        sys.exit(result.returncode)

    args.done_file.write_text(json.dumps({
        "status": "success",
        "exit_code": 0,
        "elapsed_seconds": elapsed,
        "finished_at": datetime.now(timezone.utc).isoformat(),
    }) + "\n")
    _log(f"DONE sentinel written to {args.done_file}")


if __name__ == "__main__":
    main()
