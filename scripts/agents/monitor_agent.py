"""
Monitor Subagent — checks CNN training status on the RunPod pod via SSH.
Spawned by the Orchestrator when it needs a training status report.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import anthropic

from base_agent import run_agent_loop
from _constants import MONITOR_MODEL, MONITOR_MAX_ITERATIONS, SSH_CONNECT_TIMEOUT

_SYSTEM = """You are the Monitor Agent for the CS659 CNN training pipeline.
Your job is to check the current status of a CNN training job running on a remote RunPod GPU pod.

You have three SSH-based tools:
- check_done_sentinel: Check if the DONE file exists (training finished)
- tail_training_log:   Read the last lines of the training log
- check_screen_session: Verify the screen session is still running

Steps:
1. Check if the DONE sentinel file exists.
2. If DONE exists, read its contents and report the final status.
3. If DONE does not exist, tail the training log to see the latest epoch metrics.
4. Check if the screen session is still alive.
5. Return a clear status report: DONE/IN_PROGRESS/FAILED + key metrics if available.
"""

_TOOLS = [
    {
        "name": "check_done_sentinel",
        "description": "SSH to pod and check if /workspace/DONE file exists. Returns its content or MISSING.",
        "input_schema": {
            "type": "object",
            "properties": {
                "pod_ip":   {"type": "string",  "description": "Pod public IP"},
                "pod_port": {"type": "integer", "description": "SSH port"},
            },
            "required": ["pod_ip", "pod_port"],
        },
    },
    {
        "name": "tail_training_log",
        "description": "Get the last N lines of the training log (/workspace/results/training.log).",
        "input_schema": {
            "type": "object",
            "properties": {
                "pod_ip":   {"type": "string"},
                "pod_port": {"type": "integer"},
                "n_lines":  {"type": "integer", "description": "Lines to tail (default 60)"},
            },
            "required": ["pod_ip", "pod_port"],
        },
    },
    {
        "name": "check_screen_session",
        "description": "Check if the 'train_cnn' screen session is still running on the pod.",
        "input_schema": {
            "type": "object",
            "properties": {
                "pod_ip":   {"type": "string"},
                "pod_port": {"type": "integer"},
            },
            "required": ["pod_ip", "pod_port"],
        },
    },
]


def _ssh_run(ip: str, port: int, cmd: str, timeout: int = SSH_CONNECT_TIMEOUT) -> str:
    result = subprocess.run(
        ["ssh", "-p", str(port), "-o", "StrictHostKeyChecking=no",
         "-o", f"ConnectTimeout={timeout}", f"root@{ip}", cmd],
        capture_output=True, text=True, timeout=timeout + 5,
    )
    return (result.stdout + result.stderr).strip()


def _execute_tool(name: str, inputs: dict) -> str:
    ip   = inputs["pod_ip"]
    port = inputs["pod_port"]

    if name == "check_done_sentinel":
        return _ssh_run(ip, port, "cat /workspace/DONE 2>/dev/null || echo MISSING")

    if name == "tail_training_log":
        n = inputs.get("n_lines", 60)
        return _ssh_run(ip, port, f"tail -n {n} /workspace/results/training.log 2>/dev/null || echo 'Log not found'")

    if name == "check_screen_session":
        return _ssh_run(ip, port, "screen -list 2>&1")

    raise ValueError(f"Unknown tool: {name}")


def run(client: anthropic.Anthropic, pod_ip: str, pod_port: int) -> str:
    """Run the monitor agent and return its status report."""
    return run_agent_loop(
        client=client,
        agent_name="MonitorAgent",
        system_prompt=_SYSTEM,
        tools=_TOOLS,
        initial_message=(
            f"Check the CNN training status on pod at {pod_ip}:{pod_port}. "
            "Report: training DONE/IN_PROGRESS/FAILED, latest epoch metrics if available."
        ),
        tool_executor=_execute_tool,
        model=MONITOR_MODEL,
        max_iterations=MONITOR_MAX_ITERATIONS,
    )
