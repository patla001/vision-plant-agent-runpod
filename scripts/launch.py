#!/usr/bin/env python3
"""
Upload scripts to the RunPod pod and start the training pipeline.

Reads pod_info.json (written by provision.py) for SSH connection details.
Requires your SSH public key to be registered in RunPod account settings
(runpod.io → Settings → SSH Public Key).

Usage:
    python scripts/launch.py
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).parent
REPO_ROOT   = SCRIPTS_DIR.parent
DL_DIR      = REPO_ROOT / "DeepLearning-tensorFlowLite"


def _ssh(ip: str, port: int, cmd: str, *, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["ssh", "-p", str(port), "-o", "StrictHostKeyChecking=no", f"root@{ip}", cmd],
        check=check,
    )


def _scp(ip: str, port: int, local: Path, remote: str) -> None:
    subprocess.run(
        ["scp", "-P", str(port), "-o", "StrictHostKeyChecking=no",
         str(local), f"root@{ip}:{remote}"],
        check=True,
    )


def main() -> None:
    pod_info_path = SCRIPTS_DIR / "pod_info.json"
    if not pod_info_path.exists():
        sys.exit("pod_info.json not found. Run provision.py first.")

    info = json.loads(pod_info_path.read_text())
    ip, port, pod_id = info["ip"], info["port"], info["pod_id"]
    print(f"Connecting to pod {pod_id} at {ip}:{port} …")

    # Upload pod_setup.sh and training_wrapper.py to /workspace on the pod
    print("Uploading scripts …")
    _scp(ip, port, SCRIPTS_DIR / "pod_setup.sh",      "/workspace/pod_setup.sh")
    _scp(ip, port, DL_DIR / "training_wrapper.py",    "/workspace/training_wrapper.py")

    # Make pod_setup.sh executable and run it (this starts the screen session)
    print("Running pod_setup.sh … (this takes ~15 min for download + setup)")
    _ssh(ip, port, "chmod +x /workspace/pod_setup.sh && bash /workspace/pod_setup.sh")

    print("\nSetup complete. Training is running in screen session 'train_cnn'.")
    print(f"Monitor with:  ssh -p {port} root@{ip} 'screen -r train_cnn'")
    print(f"Or run:        python scripts/monitor_and_download.py")


if __name__ == "__main__":
    main()
