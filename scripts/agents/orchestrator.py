"""
Orchestrator Agent — top-level Claude agent that manages the full training pipeline.

Responsibilities:
  1. Provision a RunPod GPU pod
  2. Upload scripts and launch CNN training in a screen session
  3. Periodically delegate to MonitorAgent to check training status
  4. Download results when training is complete
  5. Terminate the pod (stops billing)
  6. Delegate to AnalysisAgent to interpret results
  7. Return a final pipeline summary

Sub-agents are called as tool implementations — the Orchestrator's tool
`check_training_status` spawns a MonitorAgent Claude call; `analyze_results`
spawns an AnalysisAgent Claude call.
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

import anthropic

# Ensure sibling modules are importable when called from run_pipeline.py
sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent))

from pipeline_state import write_state

import monitor_agent
import analysis_agent
import runpod_api
from base_agent import run_agent_loop

SCRIPTS_DIR = Path(__file__).parent.parent
REPO_ROOT   = SCRIPTS_DIR.parent
DL_DIR      = REPO_ROOT / "DeepLearning-tensorFlowLite"
LOCAL_RESULTS = REPO_ROOT / "results"

_SYSTEM = """You are the Orchestrator Agent for the CS659 plant-classification CNN training pipeline.

You manage the complete end-to-end lifecycle:
  1. provision_pod        — create a RunPod RTX 4090 GPU pod
  2. wait_for_pod_ready   — wait until SSH is available
  3. launch_training      — upload scripts, start training in a screen session
  4. check_training_status — delegate to MonitorAgent; repeat every 5 min until DONE
  5. download_results     — rsync results to local machine
  6. terminate_pod        — kill the pod immediately (stops billing)
  7. analyze_results      — delegate to AnalysisAgent for interpretation
  8. report               — summarize the whole pipeline run

Rules:
- Always terminate the pod after results are downloaded, even if training failed.
- If check_training_status reports DONE, immediately download and terminate.
- If check_training_status reports IN_PROGRESS, wait 5 minutes then check again.
- If check_training_status reports FAILED after an error, download logs first, then terminate.
- Never skip the pod termination step — every minute costs money.
"""

_TOOLS = [
    {
        "name": "provision_pod",
        "description": "Create a RunPod RTX 4090 GPU pod (150 GB disk). Returns the pod_id string.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "wait_for_pod_ready",
        "description": "Wait until the pod's SSH port is reachable. Returns {ip, port}.",
        "input_schema": {
            "type": "object",
            "properties": {"pod_id": {"type": "string"}},
            "required": ["pod_id"],
        },
    },
    {
        "name": "launch_training",
        "description": "SCP setup scripts to the pod and start CNN training in a screen session.",
        "input_schema": {
            "type": "object",
            "properties": {
                "pod_ip":   {"type": "string"},
                "pod_port": {"type": "integer"},
            },
            "required": ["pod_ip", "pod_port"],
        },
    },
    {
        "name": "check_training_status",
        "description": (
            "Delegate to the Monitor subagent to check CNN training progress. "
            "Returns a status string: DONE, IN_PROGRESS, or FAILED with details."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "pod_ip":   {"type": "string"},
                "pod_port": {"type": "integer"},
            },
            "required": ["pod_ip", "pod_port"],
        },
    },
    {
        "name": "wait_minutes",
        "description": "Pause for N minutes before the next status check. Use between monitoring polls.",
        "input_schema": {
            "type": "object",
            "properties": {"minutes": {"type": "number", "description": "Minutes to wait (default 5)"}},
            "required": [],
        },
    },
    {
        "name": "download_results",
        "description": "rsync /workspace/results/ from the pod to the local results/ directory.",
        "input_schema": {
            "type": "object",
            "properties": {
                "pod_ip":   {"type": "string"},
                "pod_port": {"type": "integer"},
            },
            "required": ["pod_ip", "pod_port"],
        },
    },
    {
        "name": "terminate_pod",
        "description": "Terminate the RunPod pod. Billing stops immediately.",
        "input_schema": {
            "type": "object",
            "properties": {"pod_id": {"type": "string"}},
            "required": ["pod_id"],
        },
    },
    {
        "name": "analyze_results",
        "description": (
            "Delegate to the Analysis subagent. It reads local results/, produces a "
            "detailed markdown report, and returns a summary."
        ),
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
]


def _scp(ip: str, port: int, local: Path, remote: str) -> None:
    subprocess.run(
        ["scp", "-P", str(port), "-o", "StrictHostKeyChecking=no",
         str(local), f"root@{ip}:{remote}"],
        check=True,
    )


def _ssh(ip: str, port: int, cmd: str, *, check: bool = True, timeout: int = 60) -> str:
    """Run a command on the pod via SSH. Raises on non-zero exit when check=True
    (the default) — this prevents silent failures where a remote command returns
    127/non-zero but the orchestrator believes everything is fine."""
    r = subprocess.run(
        ["ssh", "-p", str(port), "-o", "StrictHostKeyChecking=no",
         "-o", "ConnectTimeout=20", f"root@{ip}", cmd],
        capture_output=True, text=True, timeout=timeout,
    )
    output = (r.stdout + r.stderr).strip()
    if check and r.returncode != 0:
        raise RuntimeError(
            f"SSH command failed (exit {r.returncode}):\n"
            f"  cmd: {cmd[:120]}{'...' if len(cmd) > 120 else ''}\n"
            f"  output: {output}"
        )
    return output


def make_tool_executor(client: anthropic.Anthropic, pod_id_ref: list) -> callable:
    """
    Returns a tool executor closure that captures client and a mutable pod_id_ref.
    pod_id_ref[0] is updated when provision_pod runs so terminate_pod can use it.
    """

    def execute(name: str, inputs: dict) -> str:
        if name == "provision_pod":
            write_state("running", "Provisioning RTX 4090 GPU pod on RunPod...")
            pod_id = runpod_api.create_pod(
                name="cs659-cnn-training",
                gpu_type="NVIDIA GeForce RTX 4090",
                disk_gb=150,
            )
            pod_id_ref[0] = pod_id
            write_state("running", f"Pod created: {pod_id}", pod_id=pod_id)
            return json.dumps({"pod_id": pod_id})

        if name == "wait_for_pod_ready":
            write_state("running", "Waiting for pod SSH to become available...")
            pod_id = inputs["pod_id"]
            ip, port = runpod_api.wait_for_pod(pod_id)
            write_state("running", f"Pod ready — SSH: {ip}:{port}", pod_ip=ip, pod_port=port)
            return json.dumps({"ip": ip, "port": port})

        if name == "launch_training":
            write_state("running", "Uploading scripts and starting dataset download on pod...")
            ip, port = inputs["pod_ip"], inputs["pod_port"]
            _scp(ip, port, SCRIPTS_DIR / "pod_setup.sh",        "/workspace/pod_setup.sh")
            _scp(ip, port, DL_DIR / "training_wrapper.py",      "/workspace/training_wrapper.py")
            # pod_setup.sh runs wget (31.7 GB), unzip, pip install, flatten — total ~15 min.
            # We use `nohup` (always available — unlike `screen`/`tmux` which some RunPod
            # images don't ship). The setup script runs in the background; SSH returns
            # in ~2 sec. Verify the process actually started by checking its PID is alive
            # one second after launch — this catches "command not found" / "permission denied"
            # type failures that would otherwise be silent.
            output = _ssh(
                ip, port,
                "set -e && "
                "chmod +x /workspace/pod_setup.sh && "
                "nohup bash /workspace/pod_setup.sh "
                ">  /workspace/setup.log 2>&1 < /dev/null & "
                "echo $! > /workspace/setup.pid && "
                "sleep 1 && "
                "kill -0 $(cat /workspace/setup.pid) "
                "&& echo SETUP_RUNNING || (echo SETUP_DEAD; tail -50 /workspace/setup.log; exit 1)"
            )
            if "SETUP_RUNNING" not in output:
                raise RuntimeError(f"Setup script failed to start. Output: {output}")
            write_state("running", "Pod setup running (downloading 31.7 GB dataset, ~15 min)")
            return ("Pod setup launched via nohup (PID saved to /workspace/setup.pid). "
                    "Logs at /workspace/setup.log. "
                    "Training will start automatically when setup finishes (~15 min).")

        if name == "check_training_status":
            write_state("running", "Delegating to MonitorAgent — checking training status...")
            # ── Spawn MonitorAgent subagent ──────────────────────────────
            ip, port = inputs["pod_ip"], inputs["pod_port"]
            report = monitor_agent.run(client, ip, port)
            write_state("running", f"Monitor report: {report[:120]}")
            return report

        if name == "wait_minutes":
            minutes = inputs.get("minutes", 5)
            write_state("running", f"CNN training in progress — next check in {minutes} min...")
            time.sleep(int(minutes) * 60)
            return f"Waited {minutes} minutes."

        if name == "download_results":
            write_state("running", "Downloading training results from pod...")
            ip, port = inputs["pod_ip"], inputs["pod_port"]
            LOCAL_RESULTS.mkdir(parents=True, exist_ok=True)
            subprocess.run(
                ["rsync", "-avz", "--progress",
                 "-e", f"ssh -p {port} -o StrictHostKeyChecking=no",
                 f"root@{ip}:/workspace/results/",
                 str(LOCAL_RESULTS) + "/"],
                check=True,
            )
            # Also grab the DONE file
            subprocess.run(
                ["scp", "-P", str(port), "-o", "StrictHostKeyChecking=no",
                 f"root@{ip}:/workspace/DONE",
                 str(LOCAL_RESULTS) + "/DONE"],
                check=False,
            )
            write_state("running", "Results downloaded successfully")
            return f"Results downloaded to {LOCAL_RESULTS}"

        if name == "terminate_pod":
            write_state("running", "Terminating pod — stopping billing...")
            pod_id = inputs.get("pod_id") or pod_id_ref[0]
            if not pod_id:
                return "Error: no pod_id available."
            runpod_api.terminate_pod(pod_id)
            write_state("running", f"Pod {pod_id} terminated. Billing stopped.")
            return f"Pod {pod_id} terminated. Billing stopped."

        if name == "analyze_results":
            write_state("running", "Delegating to AnalysisAgent — interpreting results...")
            # ── Spawn AnalysisAgent subagent ─────────────────────────────
            report = analysis_agent.run(client)
            write_state("running", "Analysis complete")
            return report

        raise ValueError(f"Unknown tool: {name}")

    return execute


def run(client: anthropic.Anthropic) -> str:
    """Run the full orchestrator pipeline. Returns the final summary."""
    pod_id_ref: list = [None]   # mutable reference so tool executor can share pod_id

    return run_agent_loop(
        client=client,
        agent_name="Orchestrator",
        system_prompt=_SYSTEM,
        tools=_TOOLS,
        initial_message=(
            "Run the complete CS659 CNN training pipeline:\n"
            "1. Provision a RunPod RTX 4090 pod\n"
            "2. Launch CNN training on PlantNet-300K (wget → flatten → train)\n"
            "3. Monitor training every 5 minutes until done\n"
            "4. Download results and terminate the pod\n"
            "5. Analyze results and return a final summary\n"
            "Proceed autonomously. Remember to ALWAYS terminate the pod."
        ),
        tool_executor=make_tool_executor(client, pod_id_ref),
        model="claude-opus-4-7",
        # Long pipeline: provision (1) + wait_ssh (1) + launch (1) + N×{monitor + wait_minutes}
        # + download (1) + terminate (1) + analyze (1) = 6 + 2N. For 4-hour training
        # with 5-min polls, N≈48, so 6 + 96 = 102 iterations. 200 leaves headroom.
        max_iterations=200,
    )
