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
  1. SETUP   — pod_setup.sh runs apt-get install + wget (31.7 GB dataset) +
               unzip + pip install + flatten symlinks. Progress logged to
               /workspace/setup.log. Runs as a nohup background process
               (PID in /workspace/setup.pid). Takes ~15 minutes.
  2. TRAINING — train_cnn screen session runs the CNN. Logs to
               /workspace/results/training.log. DONE sentinel written when complete.

You have these SSH-based tools:
- check_done_sentinel: Check if /workspace/DONE exists (training finished)
- tail_training_log:   Read last lines of /workspace/results/training.log (TRAINING phase)
- tail_setup_log:      Read last lines of /workspace/setup.log (SETUP phase)
- check_screen_session: List running screen sessions (only 'train_cnn' during TRAINING phase)

CRITICAL: If ANY tool response begins with the literal string 'POD_UNREACHABLE:', the
pod has died (RunPod evicted the host, network failed, etc.). In that case, do NOT
report 'IN_PROGRESS' — report 'POD_UNREACHABLE' so the orchestrator can terminate
the dead pod and abort. Continuing to poll a dead pod wastes time and money.

Steps:
1. Check if DONE sentinel exists. If yes, training is complete — report DONE + status.
2. If any tool returns 'POD_UNREACHABLE:' → report POD_UNREACHABLE immediately.
3. Tail setup.log AND training.log to determine which phase we're in:
   - setup.log growing, no training.log yet → SETUP_IN_PROGRESS
   - training.log exists and growing → TRAINING_IN_PROGRESS
   - check_screen_session shows train_cnn alive → TRAINING_IN_PROGRESS
   - Neither log growing for several checks and no DONE → FAILED
4. Return a clear status report: DONE / SETUP_IN_PROGRESS / TRAINING_IN_PROGRESS /
   POD_UNREACHABLE / FAILED.
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


SSH_CONNECT_TIMEOUT = 20      # seconds
MAX_TOOL_OUTPUT_BYTES = 16000  # ~4K tokens; bounds Monitor context regardless of log size


def _ssh_run(ip: str, port: int, cmd: str, timeout: int = SSH_CONNECT_TIMEOUT) -> str:
    """Run a command on the pod via SSH and return its output.

    Output is hard-capped at MAX_TOOL_OUTPUT_BYTES to keep the Monitor's
    context under Haiku 4.5's 200K limit even when training.log contains
    pathologically long lines (e.g. Keras progress bars with embedded \\r
    overwrites that tail -n cannot bound).

    If SSH itself fails (connection refused, timeout, host down), prefix the
    output with 'POD_UNREACHABLE:'. The agent is instructed to recognize this
    sentinel and report POD_UNREACHABLE / FAILED to the orchestrator instead
    of treating SSH errors as legitimate "no progress yet" data.
    """
    try:
        result = subprocess.run(
            ["ssh", "-T", "-n",
             "-p", str(port),
             "-o", "StrictHostKeyChecking=no",
             "-o", f"ConnectTimeout={timeout}",
             f"root@{ip}", cmd],
            capture_output=True, text=True, timeout=timeout + 5,
        )
    except subprocess.TimeoutExpired:
        return f"POD_UNREACHABLE: ssh subprocess timed out after {timeout + 5}s"

    output = (result.stdout + result.stderr).strip()

    # SSH connection-level failures (255 is the canonical 'ssh failed to
    # establish session' exit code; we also pattern-match common error
    # messages for robustness).
    ssh_failed = result.returncode == 255 or any(
        marker in output.lower() for marker in (
            "connection refused", "connection reset", "no route to host",
            "host is down", "name or service not known", "operation timed out",
        )
    )
    if ssh_failed:
        return f"POD_UNREACHABLE: {output[:MAX_TOOL_OUTPUT_BYTES]}"

    if len(output) > MAX_TOOL_OUTPUT_BYTES:
        # Keep the tail — that's where the latest training progress lives.
        output = f"[...truncated {len(output) - MAX_TOOL_OUTPUT_BYTES} bytes...]\n" + output[-MAX_TOOL_OUTPUT_BYTES:]

    return output


def _execute_tool(name: str, inputs: dict) -> str:
    ip   = inputs["pod_ip"]
    port = inputs["pod_port"]

    if name == "check_done_sentinel":
        return _ssh_run(ip, port, "cat /workspace/DONE 2>/dev/null || echo MISSING")

    if name == "tail_training_log":
        n = inputs.get("n_lines", 60)
        # Translate \r to \n so Keras progress bars (which overwrite a single
        # line via carriage returns) become discrete lines that `tail -n` can
        # actually bound. Without this, "60 lines" can be hundreds of KB.
        # `[ -f file ]` precedes the pipe so a missing file still prints the
        # fallback — relying on `tr | tail || echo` doesn't work because tail
        # exits 0 on empty stdin even when tr's input redirection fails.
        return _ssh_run(ip, port, f"[ -f /workspace/results/training.log ] && tr '\\r' '\\n' < /workspace/results/training.log | tail -n {n} || echo 'Log not found'")

    if name == "tail_setup_log":
        n = inputs.get("n_lines", 30)
        return _ssh_run(ip, port, f"[ -f /workspace/setup.log ] && tr '\\r' '\\n' < /workspace/setup.log | tail -n {n} || echo 'Setup log not found'")

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
