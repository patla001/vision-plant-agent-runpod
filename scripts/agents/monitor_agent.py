"""
Monitor Subagent — checks CNN training status on the RunPod pod via SSH.
Spawned by the Orchestrator when it needs a training status report.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import anthropic

from base_agent import run_agent_loop

_SYSTEM = """You are the Monitor Agent for the CS659 CNN training pipeline.
Your job is to check the current status of a CNN training job running on a remote RunPod GPU pod.

The pod goes through TWO phases:
  1. SETUP   — pod_setup.sh runs wget (31.7 GB dataset), unzip, pip install, flatten symlinks.
               Progress logged to /workspace/setup.log. Runs in screen session 'pod_setup'.
               Takes ~15 minutes.
  2. TRAINING — train_cnn screen session runs the CNN. Logs to /workspace/results/training.log.
               DONE sentinel written when complete.

You have these SSH-based tools:
- check_done_sentinel: Check if /workspace/DONE exists (training finished)
- tail_training_log:   Read last lines of /workspace/results/training.log (TRAINING phase)
- tail_setup_log:      Read last lines of /workspace/setup.log (SETUP phase)
- check_screen_session: Verify pod_setup or train_cnn screen sessions are running

Steps:
1. Check if DONE sentinel exists. If yes, training is complete — report DONE + status.
2. Check screen sessions to determine which phase we're in:
   - Only 'pod_setup' alive → still in SETUP phase, tail setup.log
   - Only 'train_cnn' alive → in TRAINING phase, tail training.log
   - Both dead and no DONE → something failed, report FAILED with last log lines
3. Return a clear status report: DONE / SETUP_IN_PROGRESS / TRAINING_IN_PROGRESS / FAILED.
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
        "name": "tail_setup_log",
        "description": "Get the last N lines of the SETUP log (/workspace/setup.log) — wget/unzip/pip install/flatten progress.",
        "input_schema": {
            "type": "object",
            "properties": {
                "pod_ip":   {"type": "string"},
                "pod_port": {"type": "integer"},
                "n_lines":  {"type": "integer", "description": "Lines to tail (default 30)"},
            },
            "required": ["pod_ip", "pod_port"],
        },
    },
    {
        "name": "check_screen_session",
        "description": "List all running screen sessions on the pod (pod_setup, train_cnn, or both).",
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


def _ssh_run(ip: str, port: int, cmd: str, timeout: int = 20) -> str:
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

    if name == "tail_setup_log":
        n = inputs.get("n_lines", 30)
        return _ssh_run(ip, port, f"tail -n {n} /workspace/setup.log 2>/dev/null || echo 'Setup log not found'")

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
        model="claude-haiku-4-5",   # simple status check → cheapest model
        max_iterations=10,
    )
