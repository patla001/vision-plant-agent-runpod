"""
Centralized configuration constants for the multi-agent pipeline.

Hoisted from individual agent files so all tunable values are in one place.
None of these are user-facing; they're internal to how the pipeline runs.
"""

# ── Anthropic models ──────────────────────────────────────────
ORCHESTRATOR_MODEL = "claude-opus-4-7"
MONITOR_MODEL      = "claude-haiku-4-5"
ANALYSIS_MODEL     = "claude-opus-4-7"

# ── Agent loop iteration caps ─────────────────────────────────
# Orchestrator: provision (1) + wait_ssh (1) + launch (1) + N×{monitor + wait}
#               + download (1) + terminate (1) + analyze (1) = 6 + 2N.
#               For 4-hour training with 5-min polls, N≈48, so we need ≈102.
ORCHESTRATOR_MAX_ITERATIONS = 200
MONITOR_MAX_ITERATIONS      = 10   # just a few SSH probes per check
ANALYSIS_MAX_ITERATIONS     = 15   # a few file reads + write report

# ── Token budgets ─────────────────────────────────────────────
DEFAULT_MAX_TOKENS = 16000

# ── RunPod pod configuration ──────────────────────────────────
POD_NAME            = "cs659-cnn-training"
DEFAULT_GPU_TYPE    = "NVIDIA GeForce RTX 4090"
DEFAULT_DISK_GB     = 150
POD_DOCKER_IMAGE    = "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04"

# ── Timeouts (seconds) ────────────────────────────────────────
POD_READY_TIMEOUT_SEC  = 600   # how long to wait for SSH after pod create
SSH_CONNECT_TIMEOUT    = 20    # per-SSH-call connect timeout
RUNPOD_API_TIMEOUT     = 30    # GraphQL request timeout

# ── Monitoring cadence ────────────────────────────────────────
DEFAULT_WAIT_MINUTES = 5       # orchestrator's default between status checks
