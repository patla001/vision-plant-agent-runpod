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
    parser.add_argument("--data_dir",   required=True,  type=Path)
    parser.add_argument("--result_dir", required=True,  type=Path)
    parser.add_argument("--done_file",  required=True,  type=Path)
    parser.add_argument("--config",     default=Path(__file__).parent / "model_hyperparameters.json", type=Path)
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

    script = Path(__file__).parent / "train_export_tflite.py"

    cmd = [
        sys.executable, str(script),
        "--data_dir",  str(args.data_dir),
        "--log_dir",   str(args.result_dir),
        # All other hyperparameter defaults are read from model_hyperparameters.json
        # by train_export_tflite.py automatically via experiment_config.merge_config_into_argparse_defaults
    ]

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
