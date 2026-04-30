"""
Shared logging helper used by all agents in this directory.

Format:
    [HH:MM:SS UTC][AgentName] message text

Output goes to stdout, which is captured by the Next.js dashboard's
`/api/pipeline/logs` SSE endpoint (the dashboard's start route redirects
the Python subprocess's stdout to results/pipeline.log).
"""
from __future__ import annotations

from datetime import datetime, timezone


def log(agent_name: str, msg: str) -> None:
    """Print a timestamped, agent-tagged log line. flush=True so the dashboard
    sees output in near-real-time without buffering delays."""
    ts = datetime.now(timezone.utc).strftime("%H:%M:%S UTC")
    print(f"[{ts}][{agent_name}] {msg}", flush=True)
