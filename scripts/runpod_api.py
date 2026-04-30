"""RunPod GraphQL API client — create, poll, and terminate pods."""
from __future__ import annotations

import os
import sys
import time
import socket
import requests

# Allow `from _constants import ...` when this module is imported via the agent path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "agents"))
from _constants import (
    DEFAULT_GPU_TYPE,
    DEFAULT_DISK_GB,
    POD_DOCKER_IMAGE,
    POD_READY_TIMEOUT_SEC,
    RUNPOD_API_TIMEOUT,
)

_GQL = "https://api.runpod.io/graphql"


def _call(query: str, variables: dict | None = None) -> dict:
    key = os.environ.get("RUNPOD_API_KEY", "")
    if not key:
        raise RuntimeError("RUNPOD_API_KEY is not set")
    resp = requests.post(
        f"{_GQL}?api_key={key}",
        json={"query": query, "variables": variables or {}},
        timeout=RUNPOD_API_TIMEOUT,
    )
    resp.raise_for_status()
    body = resp.json()
    if "errors" in body:
        raise RuntimeError(f"RunPod API error: {body['errors']}")
    return body["data"]


def create_pod(
    name: str,
    gpu_type: str = DEFAULT_GPU_TYPE,
    disk_gb: int = DEFAULT_DISK_GB,
) -> str:
    """Create an on-demand pod. Returns pod_id."""
    data = _call(
        """
        mutation CreatePod($input: PodFindAndDeployOnDemandInput!) {
            podFindAndDeployOnDemand(input: $input) { id }
        }
        """,
        {
            "input": {
                "name": name,
                "imageName": POD_DOCKER_IMAGE,
                "gpuTypeId": gpu_type,
                "cloudType": "SECURE",
                "gpuCount": 1,
                "volumeInGb": 0,
                "containerDiskInGb": disk_gb,
                "minVcpuCount": 8,
                "minMemoryInGb": 29,
                "ports": "22/tcp",
                "supportPublicIp": True,
                "startSsh": True,
            }
        },
    )
    return data["podFindAndDeployOnDemand"]["id"]


def get_ssh_endpoint(pod_id: str) -> tuple[str, int] | tuple[None, None]:
    """Return (ip, port) for SSH, or (None, None) if not ready yet."""
    data = _call(
        """
        query GetPod($podId: String!) {
            pod(input: {podId: $podId}) {
                desiredStatus
                runtime {
                    ports { ip privatePort publicPort type }
                }
            }
        }
        """,
        {"podId": pod_id},
    )
    pod = data.get("pod") or {}
    runtime = pod.get("runtime") or {}
    for p in runtime.get("ports") or []:
        if p["privatePort"] == 22 and p["type"] == "tcp":
            return p["ip"], int(p["publicPort"])
    return None, None


def wait_for_pod(pod_id: str, timeout: int = POD_READY_TIMEOUT_SEC) -> tuple[str, int]:
    """Block until SSH port is reachable. Returns (ip, port)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        ip, port = get_ssh_endpoint(pod_id)
        if ip and port:
            # Wait until the TCP port actually accepts connections
            try:
                with socket.create_connection((ip, port), timeout=5):
                    print(f"Pod ready — SSH: ssh -p {port} root@{ip}", flush=True)
                    return ip, port
            except OSError:
                pass
        print("  Pod not ready yet, waiting 15 s …", flush=True)
        time.sleep(15)
    raise TimeoutError(f"Pod {pod_id} not SSH-ready after {timeout}s")


def terminate_pod(pod_id: str) -> None:
    """Terminate (delete) a pod. RunPod stops billing immediately."""
    _call(
        """
        mutation TerminatePod($podId: String!) {
            podTerminate(input: {podId: $podId})
        }
        """,
        {"podId": pod_id},
    )
    print(f"Pod {pod_id} terminated.", flush=True)
