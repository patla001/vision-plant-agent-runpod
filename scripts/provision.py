#!/usr/bin/env python3
"""
Provision a RunPod RTX 4090 pod and save SSH connection details to pod_info.json.

Usage:
    python provision.py

Requires:
    RUNPOD_API_KEY in .env or environment.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).parent))
import runpod_api

load_dotenv(Path(__file__).parent.parent / ".env")

POD_NAME    = "cs659-cnn-training"
GPU_TYPE    = "NVIDIA GeForce RTX 4090"
DISK_GB     = 150   # 32 GB zip + ~70 GB extracted + workspace headroom


def main() -> None:
    if not os.environ.get("RUNPOD_API_KEY"):
        sys.exit("Error: RUNPOD_API_KEY not set. Add it to .env in the repo root.")

    print(f"Creating pod '{POD_NAME}' ({GPU_TYPE}, {DISK_GB} GB disk) …")
    pod_id = runpod_api.create_pod(POD_NAME, GPU_TYPE, DISK_GB)
    print(f"Pod ID: {pod_id}")

    ip, port = runpod_api.wait_for_pod(pod_id)

    pod_info = {"pod_id": pod_id, "ip": ip, "port": port}
    out = Path(__file__).parent / "pod_info.json"
    out.write_text(json.dumps(pod_info, indent=2) + "\n")
    print(f"Saved connection details → {out}")
    print(f"\nNext step:\n  python scripts/launch.py")


if __name__ == "__main__":
    main()
