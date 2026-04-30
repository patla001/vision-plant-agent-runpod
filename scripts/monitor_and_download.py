#!/usr/bin/env python3
"""
Poll the RunPod pod every 5 minutes for the DONE sentinel file.
When found:
  1. rsync /workspace/results/ → local results/
  2. Terminate the pod (billing stops immediately)
  3. Print a summary of what was downloaded

The poll uses time.sleep on the LOCAL machine (not the GPU pod), so it
costs nothing while waiting. The GPU pod is only billed while running.

Usage:
    python scripts/monitor_and_download.py

Reads pod_info.json written by provision.py.
Requires RUNPOD_API_KEY in .env.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

SCRIPTS_DIR  = Path(__file__).parent
REPO_ROOT    = SCRIPTS_DIR.parent
LOCAL_RESULTS = REPO_ROOT / "results"

POLL_INTERVAL = 300   # 5 minutes between SSH checks
REMOTE_DONE   = "/workspace/DONE"
REMOTE_RESULTS = "/workspace/results/"

load_dotenv(REPO_ROOT / ".env")
sys.path.insert(0, str(SCRIPTS_DIR))
import runpod_api


def _log(msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    print(f"[{ts}] {msg}", flush=True)


def _check_done(ip: str, port: int) -> dict | None:
    """Return parsed DONE JSON if sentinel exists, else None."""
    result = subprocess.run(
        ["ssh", "-p", str(port), "-o", "StrictHostKeyChecking=no",
         "-o", "ConnectTimeout=15", f"root@{ip}",
         f"cat {REMOTE_DONE} 2>/dev/null || echo MISSING"],
        capture_output=True, text=True, timeout=30,
    )
    out = result.stdout.strip()
    if out == "MISSING" or not out:
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return None


def _rsync_results(ip: str, port: int) -> None:
    LOCAL_RESULTS.mkdir(parents=True, exist_ok=True)
    _log(f"Downloading results → {LOCAL_RESULTS} …")
    subprocess.run(
        [
            "rsync", "-avz", "--progress",
            "-e", f"ssh -p {port} -o StrictHostKeyChecking=no",
            f"root@{ip}:{REMOTE_RESULTS}",
            str(LOCAL_RESULTS) + "/",
        ],
        check=True,
    )
    _log("Download complete.")


def _print_summary() -> None:
    _log("=== Downloaded files ===")
    for f in sorted(LOCAL_RESULTS.rglob("*")):
        if f.is_file():
            size = f.stat().st_size
            label = f"{size / 1024:.1f} KB" if size < 1_048_576 else f"{size / 1_048_576:.1f} MB"
            print(f"  {f.relative_to(REPO_ROOT)}  ({label})")


def main() -> None:
    pod_info_path = SCRIPTS_DIR / "pod_info.json"
    if not pod_info_path.exists():
        sys.exit("pod_info.json not found. Run provision.py first.")

    if not os.environ.get("RUNPOD_API_KEY"):
        sys.exit("RUNPOD_API_KEY not set. Add it to .env.")

    info  = json.loads(pod_info_path.read_text())
    ip, port, pod_id = info["ip"], info["port"], info["pod_id"]

    _log(f"Monitoring pod {pod_id} at {ip}:{port}")
    _log(f"Polling every {POLL_INTERVAL // 60} minutes. Ctrl-C to abort (pod keeps running).")

    while True:
        try:
            done = _check_done(ip, port)
        except Exception as exc:
            _log(f"SSH check failed ({exc}), will retry …")
            done = None

        if done is not None:
            _log(f"Training finished — status: {done.get('status')}, "
                 f"elapsed: {done.get('elapsed_seconds', 0) / 3600:.1f} h")
            _rsync_results(ip, port)
            _log(f"Terminating pod {pod_id} …")
            runpod_api.terminate_pod(pod_id)
            _print_summary()
            _log("All done. View results with: cd dashboard && npm run dev")
            pod_info_path.unlink(missing_ok=True)   # remove stale connection info
            break

        _log(f"Still training … next check in {POLL_INTERVAL // 60} min")
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
