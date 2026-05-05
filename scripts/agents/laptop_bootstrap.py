#!/usr/bin/env python3
"""Laptop-side bootstrapper.

Runs ONCE on the user's laptop when they click Start. Provisions a pod,
copies code + secrets to it, and launches the pod-side orchestrator
inside a screen session. After this script exits, the pod is fully
autonomous — laptop can shut down.

Replaces the older laptop-side run_pipeline.py / orchestrator.py flow,
where the Claude agent loop ran on the laptop and required it to stay
online for hours. The Claude agent now runs on the pod via
pod_orchestrator.py.

State written to results/pipeline_state.json:
  pod_id, pod_ip, pod_port, run_tag, color_correct, status="running-on-pod"

The dashboard reattaches to a run by reading pipeline_state.json and
querying the RunPod API + GitHub Releases to determine current state.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT     = Path(__file__).resolve().parents[2]
SCRIPTS_DIR   = REPO_ROOT / "scripts"
DL_DIR        = REPO_ROOT / "DeepLearning-tensorFlowLite"
ENV_FILE      = REPO_ROOT / ".env"
LOCAL_RESULTS = REPO_ROOT / "results"
HYPERPARAMS_JSON = DL_DIR / "model_hyperparameters.json"

load_dotenv(ENV_FILE)

# Ensure agent imports resolve
sys.path.insert(0, str(SCRIPTS_DIR / "agents"))
sys.path.insert(0, str(SCRIPTS_DIR))

from pipeline_state import write_state, write_error
from _constants     import RUNPOD_GPU_TYPE, RUNPOD_DISK_GB
import runpod_api


VALID_COLOR_CORRECT = ("none", "gray_world", "max_rgb")


# RunPod's pod accepts a TCP connection on port 22 well before sshd has
# fully accepted/streamed: early SCP/SSH commands routinely die with
# "Connection closed by remote host" or transient auth errors. A small
# retry budget masks those startup hiccups without papering over real
# failures (config issues fail consistently across all attempts).
_TRANSIENT_RE = (
    "Connection closed by remote host",
    "Connection reset by peer",
    "Connection refused",
    "kex_exchange_identification",
    "Broken pipe",
)


def _is_transient(stderr: str) -> bool:
    return any(s in stderr for s in _TRANSIENT_RE)


def _scp(ip: str, port: int, local: Path, remote: str, *, retries: int = 2) -> None:
    last: Exception | None = None
    for attempt in range(retries + 1):
        try:
            subprocess.run(
                ["scp", "-q", "-P", str(port),
                 "-o", "StrictHostKeyChecking=no",
                 "-o", "ConnectTimeout=20",
                 str(local), f"root@{ip}:{remote}"],
                check=True, capture_output=True, text=True, timeout=120,
            )
            return
        except subprocess.CalledProcessError as e:
            last = e
            if attempt < retries and _is_transient(e.stderr or ""):
                time.sleep(5)
                continue
            raise
        except subprocess.TimeoutExpired as e:
            last = e
            if attempt < retries:
                time.sleep(5)
                continue
            raise
    if last:  # unreachable in practice — every path above either returns or raises
        raise last


def _scp_dir(ip: str, port: int, local_dir: Path, remote: str, *, retries: int = 2) -> None:
    last: Exception | None = None
    for attempt in range(retries + 1):
        try:
            subprocess.run(
                ["scp", "-rq", "-P", str(port),
                 "-o", "StrictHostKeyChecking=no",
                 "-o", "ConnectTimeout=20",
                 str(local_dir), f"root@{ip}:{remote}"],
                check=True, capture_output=True, text=True, timeout=180,
            )
            return
        except subprocess.CalledProcessError as e:
            last = e
            if attempt < retries and _is_transient(e.stderr or ""):
                time.sleep(5)
                continue
            raise
        except subprocess.TimeoutExpired as e:
            last = e
            if attempt < retries:
                time.sleep(5)
                continue
            raise
    if last:
        raise last


def _ssh(ip: str, port: int, cmd: str, *, timeout: int = 60, retries: int = 2) -> str:
    last: Exception | None = None
    for attempt in range(retries + 1):
        try:
            r = subprocess.run(
                ["ssh", "-T", "-n", "-p", str(port),
                 "-o", "StrictHostKeyChecking=no",
                 "-o", "ConnectTimeout=20",
                 f"root@{ip}", cmd],
                capture_output=True, text=True, timeout=timeout,
            )
            out = (r.stdout + r.stderr).strip()
            if r.returncode != 0:
                # Retry only on transient SSH-layer failures. App-level
                # non-zero exits (apt failure, etc.) fall through to raise.
                if attempt < retries and _is_transient(r.stderr or ""):
                    time.sleep(5)
                    continue
                raise RuntimeError(f"SSH failed (exit {r.returncode}): {out}")
            return out
        except subprocess.TimeoutExpired as e:
            last = e
            if attempt < retries:
                time.sleep(5)
                continue
            raise
    if last:
        raise last
    return ""


def _preflight_github_token() -> None:
    """Verify GITHUB_TOKEN can ACTUALLY create Releases — not just read the repo.

    Earlier versions of this preflight checked the `permissions.push` flag on
    GET /repos/{owner}/{repo}. That field reports the *authenticated user's*
    role on the repo, NOT the token's scoped capabilities. A fine-grained PAT
    issued to a repo owner returns push:True even when the token itself lacks
    Contents:write — and the orchestrator still 403s on create_release. This
    fooled us into burning a full 6-hour run before discovering the gap.

    The only reliable check is to attempt the actual operation. Strategy:
    POST /releases with draft=true (does NOT materialize a tag — a draft only
    references a tag name, the tag is created on publish); on 200/201 we
    immediately DELETE the draft. CREATE 201 + DELETE 204 = the orchestrator
    will succeed at second 0 of the next pod's existence.
    """
    import re
    import time as _time
    import urllib.parse
    import requests

    token = os.environ["GITHUB_TOKEN"]

    try:
        out = subprocess.check_output(
            ["git", "-C", str(REPO_ROOT), "remote", "get-url", "origin"],
            text=True, stderr=subprocess.DEVNULL,
        ).strip()
    except subprocess.CalledProcessError:
        print("Warning: cannot resolve origin URL; skipping token preflight.", file=sys.stderr)
        return
    m = re.match(r"(?:https://github\.com/|git@github\.com:)([^/]+)/([^/]+?)(?:\.git)?/?$", out)
    if not m:
        print(f"Warning: origin {out!r} is not GitHub; skipping token preflight.", file=sys.stderr)
        return
    owner, repo = m.group(1), m.group(2)
    base = f"https://api.github.com/repos/{urllib.parse.quote(owner)}/{urllib.parse.quote(repo)}"
    hdr  = {
        "Authorization": f"Bearer {token}",
        "Accept":        "application/vnd.github+json",
    }

    # Cheap sanity check first — surfaces 401/404 with the cleanest error message
    # before we attempt a write that would cascade-fail with the same root cause.
    try:
        sanity = requests.get(base, headers=hdr, timeout=10)
    except requests.RequestException as exc:
        print(f"Warning: GitHub preflight network error ({exc}); proceeding anyway.",
              file=sys.stderr)
        return
    if sanity.status_code == 401:
        print(f"Error: GITHUB_TOKEN is invalid or expired (HTTP 401 from {owner}/{repo}).",
              file=sys.stderr)
        sys.exit(1)
    if sanity.status_code == 404:
        print(f"Error: GITHUB_TOKEN cannot see {owner}/{repo}. "
              "If this is a fine-grained PAT, ensure it has access to this repository.",
              file=sys.stderr)
        sys.exit(1)

    # The actual write test. Draft releases are not visible publicly and don't
    # create a Git tag (the tag is materialized only when the draft is
    # published), so even if the DELETE below fails the only side-effect is a
    # private draft cluttering the Releases UI.
    test_tag = f"preflight-{int(_time.time())}"
    try:
        cr = requests.post(
            f"{base}/releases",
            headers=hdr,
            json={"tag_name": test_tag, "name": "preflight (auto-deleted)", "draft": True},
            timeout=15,
        )
    except requests.RequestException as exc:
        print(f"Warning: preflight write network error ({exc}); proceeding anyway.",
              file=sys.stderr)
        return

    if cr.status_code == 403:
        # The exact failure mode that motivated this check.
        try:
            msg = cr.json().get("message", "(no message)")
        except ValueError:
            msg = cr.text[:200]
        print(
            f"Error: GITHUB_TOKEN cannot create Releases on {owner}/{repo}.\n"
            f"  GitHub says: {msg}\n"
            f"  Fix this BEFORE re-running, otherwise the pod will train for hours\n"
            f"  and the orchestrator will fail to upload artifacts.\n"
            f"\n"
            f"  Fine-grained PAT (https://github.com/settings/personal-access-tokens):\n"
            f"    Repository access → confirm '{owner}/{repo}' is in the list\n"
            f"    Repository permissions → Contents → 'Read and write'\n"
            f"\n"
            f"  Classic PAT (https://github.com/settings/tokens):\n"
            f"    Generate new (classic) → tick 'repo' scope",
            file=sys.stderr,
        )
        sys.exit(1)
    if cr.status_code not in (200, 201):
        print(f"Error: preflight create returned HTTP {cr.status_code}: {cr.text[:300]}",
              file=sys.stderr)
        sys.exit(1)

    # Tear down the draft. Failure here is non-fatal but worth flagging so the
    # user knows to clean it up manually.
    rid = cr.json().get("id")
    if rid:
        try:
            dr = requests.delete(f"{base}/releases/{rid}", headers=hdr, timeout=15)
            if dr.status_code != 204:
                print(f"Warning: failed to delete preflight draft release {rid} "
                      f"(HTTP {dr.status_code}). Clean it up manually at "
                      f"https://github.com/{owner}/{repo}/releases", file=sys.stderr)
        except requests.RequestException as exc:
            print(f"Warning: delete preflight draft network error ({exc}); "
                  f"manually delete release {rid} at https://github.com/{owner}/{repo}/releases",
                  file=sys.stderr)

    print(f"GITHUB_TOKEN ✓ — verified write access on {owner}/{repo} via draft create+delete.")


def main() -> None:
    # Required env vars: ANTHROPIC + RUNPOD always; GITHUB_TOKEN now too because
    # the pod orchestrator needs it to publish Releases.
    missing = [k for k in ("RUNPOD_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN")
               if not os.environ.get(k)]
    if missing:
        print(f"Error: missing environment variables: {', '.join(missing)}", file=sys.stderr)
        print("Add them to .env in the repo root (see .env.example).", file=sys.stderr)
        sys.exit(1)

    # Validate token write access before spending money on a pod. An invalid
    # token surfaces as a 6-hour run ending with HTTP 403 from create_release;
    # this turns that into a fail-fast at second 0.
    _preflight_github_token()

    color_correct = os.environ.get("PIPELINE_COLOR_CORRECT") or None
    if color_correct and color_correct not in VALID_COLOR_CORRECT:
        print(f"Error: PIPELINE_COLOR_CORRECT={color_correct!r} not in {VALID_COLOR_CORRECT}",
              file=sys.stderr)
        sys.exit(1)

    # PIPELINE_HYPERPARAMETERS, if set, is a JSON dict of deep_learning keys to override.
    # Already validated/sanitized by the dashboard's start route (only allowed keys reach
    # us). Merged into the local model_hyperparameters.json's deep_learning section, then
    # SCP'd to the pod as /workspace/hyperparameters_override.json. pod_setup.sh applies
    # the override to the cloned repo's JSON before training.
    hp_override_path: Path | None = None
    hp_env = os.environ.get("PIPELINE_HYPERPARAMETERS")
    if hp_env:
        try:
            overrides = json.loads(hp_env)
            base = json.loads(HYPERPARAMS_JSON.read_text())
            base.setdefault("deep_learning", {}).update(overrides)
            tmp = tempfile.NamedTemporaryFile(
                "w", delete=False, suffix=".json", prefix="hp_override_")
            tmp.write(json.dumps(base, indent=2) + "\n")
            tmp.flush()
            tmp.close()
            hp_override_path = Path(tmp.name)
        except (json.JSONDecodeError, OSError) as exc:
            print(f"Error: PIPELINE_HYPERPARAMETERS could not be applied: {exc}", file=sys.stderr)
            sys.exit(1)

    # Run tag (UTC, second precision; safe for both filesystem and GitHub tag names)
    run_tag = "run-" + datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")

    print("=" * 60)
    print("CS659 Laptop Bootstrap")
    print(f"Run tag    : {run_tag}")
    print(f"GPU type   : {RUNPOD_GPU_TYPE}")
    print(f"Color corr : {color_correct or 'default (from JSON)'}")
    print("=" * 60)

    LOCAL_RESULTS.mkdir(parents=True, exist_ok=True)
    write_state("running", "Provisioning pod ...",
                pid=os.getpid(), run_tag=run_tag,
                color_correct=color_correct or "default")

    try:
        # 1. Provision
        pod_id = runpod_api.create_pod(
            name="cs659-cnn-training",
            gpu_type=RUNPOD_GPU_TYPE,
            disk_gb=RUNPOD_DISK_GB,
        )
        write_state("running", f"Pod created: {pod_id}", pod_id=pod_id, run_tag=run_tag)
        print(f"Pod created: {pod_id}")

        # 2. Wait for SSH
        write_state("running", "Waiting for SSH ...", pod_id=pod_id, run_tag=run_tag)
        ip, port = runpod_api.wait_for_pod(pod_id)
        # wait_for_pod returns as soon as the TCP port accepts a connection,
        # but RunPod's pod is often still finalizing sshd / package manager
        # state. Without this settle delay, the very first SCP of the run
        # routinely dies with "Connection closed by remote host" — the
        # daemon accepts our handshake then drops it mid-stream.
        time.sleep(15)
        write_state("running", f"Pod SSH ready ({ip}:{port})",
                    pod_id=pod_id, pod_ip=ip, pod_port=port, run_tag=run_tag)
        print(f"SSH: ssh -p {port} root@{ip}")

        # 3. Copy code + secrets to pod
        write_state("running", "Uploading code + secrets to pod ...",
                    pod_id=pod_id, pod_ip=ip, pod_port=port, run_tag=run_tag)
        # .env carries ANTHROPIC_API_KEY, RUNPOD_API_KEY, GITHUB_TOKEN
        _scp(ip, port, ENV_FILE,                              "/workspace/.env")
        _scp(ip, port, SCRIPTS_DIR / "pod_setup.sh",          "/workspace/pod_setup.sh")
        _scp(ip, port, DL_DIR / "training_wrapper.py",        "/workspace/training_wrapper.py")
        # Whole agents/ dir so pod_orchestrator can import its siblings.
        _scp_dir(ip, port, SCRIPTS_DIR / "agents",            "/workspace/agents")
        _scp(ip, port, SCRIPTS_DIR / "runpod_api.py",         "/workspace/runpod_api.py")
        _scp(ip, port, SCRIPTS_DIR / "requirements.txt",      "/workspace/agent-requirements.txt")
        # Per-run hyperparameter override (only when the user picked AI-suggested
        # or Manual on the home page). pod_setup.sh copies this over the cloned
        # repo's model_hyperparameters.json before training.
        if hp_override_path is not None:
            _scp(ip, port, hp_override_path, "/workspace/hyperparameters_override.json")
            print(f"Hyperparameter override uploaded to /workspace/hyperparameters_override.json")
        # Lock down .env so it isn't world-readable on shared image layers.
        _ssh(ip, port, "chmod 600 /workspace/.env", timeout=20)

        # 4. Launch pod_setup.sh inside a detached screen session.
        # `setsid` + redirect ensures the SSH command returns immediately.
        cc_export      = f"COLOR_CORRECT={color_correct} " if color_correct else ""
        run_tag_export = f"RUN_TAG={run_tag} "
        # CRITICAL: RUNPOD_POD_ID is set by RunPod's container init but does
        # NOT propagate into SSH sessions — sshd starts a fresh login shell
        # whose env comes from /etc/environment + ~/.bashrc, not from PID 1.
        # Both the orchestrator's self_terminate and pod_setup.sh's EXIT-trap
        # safety net read this var; without it the pod cannot terminate
        # itself and bills until manually killed (the failure mode that
        # produced the 6h-stuck pod). We know the id locally — pass it
        # through the screen's env explicitly.
        pod_id_export  = f"RUNPOD_POD_ID={pod_id} "

        write_state("running", "Launching pod_setup.sh in screen session 'cs659' ...",
                    pod_id=pod_id, pod_ip=ip, pod_port=port, run_tag=run_tag)

        # First install screen + ensure pod has it. `command -v screen`
        # short-circuits the slow path when the image already ships screen
        # (the RunPod pytorch devel image sometimes does). When we DO need
        # apt, the timeout has to cover `apt-get update` against potentially
        # cold mirrors plus a small package install — 120 s was tight on
        # slow RunPod-provider networks; bumped to 300 s.
        _ssh(ip, port,
             "command -v screen >/dev/null 2>&1 || "
             "(apt-get update -qq && apt-get install -y -qq screen)",
             timeout=300)

        # Launch the orchestrator screen session. We stash the env vars
        # via .bashrc-style export so the screen child inherits them.
        # `-L -Logfile /workspace/setup.log` tells screen to mirror the
        # entire pty output (everything you'd see in `screen -r cs659`)
        # to a file. Without this, the redirect on the screen command
        # itself only catches screen's startup errors — the bash inside
        # the pty writes to screen's internal buffer, which the dashboard
        # cannot read.
        cmd = (
            "set -e && "
            "chmod +x /workspace/pod_setup.sh && "
            "rm -f /workspace/setup.log && "
            f"( setsid env {cc_export}{run_tag_export}{pod_id_export}"
            "    screen -dmS cs659 -L -Logfile /workspace/setup.log "
            "    bash /workspace/pod_setup.sh "
            "    > /dev/null 2>&1 < /dev/null ) && "
            "sleep 2 && "
            "screen -ls | grep cs659 || (echo SCREEN_NOT_RUNNING; exit 1)"
        )
        out = _ssh(ip, port, cmd, timeout=60)
        if "cs659" not in out:
            raise RuntimeError(f"Failed to launch screen session. Output: {out}")

        write_state("running-on-pod",
                    f"Pod orchestrator launched in screen 'cs659'. "
                    f"Run tag: {run_tag}. Safe to close laptop.",
                    pod_id=pod_id, pod_ip=ip, pod_port=port,
                    run_tag=run_tag, screen_session="cs659",
                    color_correct=color_correct or "default")
        print("=" * 60)
        print(f"BOOTSTRAP COMPLETE. Pod is autonomous.")
        print(f"  Pod ID    : {pod_id}")
        print(f"  Run tag   : {run_tag}")
        print(f"  Inspect   : ssh -p {port} root@{ip}  →  screen -r cs659")
        print(f"  Release   : will appear at https://github.com/.../releases/tag/{run_tag}")
        print("=" * 60)

    except Exception as exc:
        write_error(f"Bootstrap failed: {exc}", exception=exc)
        raise


if __name__ == "__main__":
    main()
