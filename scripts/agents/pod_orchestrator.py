"""Pod-side orchestrator.

Runs ON the RunPod pod inside the cs659 screen session, AFTER training has
completed (training_wrapper.py wrote DONE). Owns the entire post-training
lifecycle — analysis → GitHub Release upload → self-terminate — without
needing the user's laptop to be online.

Architecture choice: stays a Claude-driven agent (Opus 4.7) so the multi-agent
project narrative is preserved (orchestrator + analysis-subagent). All side
effects (file reads, GitHub uploads, RunPod API calls) are exposed as tools.

Required env (loaded from /workspace/.env, SCP'd by laptop_bootstrap.py):
  ANTHROPIC_API_KEY   — Claude calls
  GITHUB_TOKEN        — Release creation + asset upload
  RUNPOD_API_KEY      — self-terminate via GraphQL
  RUNPOD_POD_ID       — pre-set by RunPod runtime; identifies this pod

Usage (from pod_setup.sh):
    python pod_orchestrator.py \\
      --results_dir /workspace/results \\
      --done_file   /workspace/DONE     \\
      --run_tag     run-2026-05-03T19-22Z
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

# Make sibling modules importable regardless of cwd
sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent))

# .env is SCP'd to /workspace/.env by the laptop bootstrap.
# Falls back to the repo-cloned location if running locally.
for env_path in (Path("/workspace/.env"), Path(__file__).resolve().parents[2] / ".env"):
    if env_path.exists():
        load_dotenv(env_path)
        break

import anthropic
import requests

import analysis_agent
import github_release_tool
import hyperparameter_suggester
import runpod_api
from base_agent import run_agent_loop
from _logging import log as _log


_SYSTEM = """You are the Pod Orchestrator Agent for the CS659 plant-classification CNN training pipeline.

You run ON the training pod itself, in a screen session, AFTER training has completed.
Your job is to wrap up the run autonomously so the user doesn't need their laptop online:

  1. analyze_results          — delegate to the AnalysisAgent for an interpretation report.
  2. suggest_hyperparameters  — diagnose overfit/underfit and write
                                suggested_hyperparameters.json so the user can pick it up
                                on their next run. Always call this even if the run looks
                                well-fit — the suggester will return diagnosis="well_fit"
                                with no changes.
  3. create_github_release    — package the .tflite + plots + CSVs + analysis report +
                                suggested_hyperparameters.json into a tagged GitHub Release.
                                This MUST come AFTER the suggestion so the file is on
                                disk and gets uploaded.
  4. self_terminate           — terminate this pod via RunPod's API. Stops billing.

Rules:
- ALWAYS call create_github_release BEFORE self_terminate. Once the pod terminates,
  any local files are gone forever. The Release is the only durable artifact.
- If create_github_release fails, retry once. If it still fails, log loudly and
  call self_terminate anyway — leaving the pod running indefinitely costs more
  than losing the run.
- Don't skip analyze_results or suggest_hyperparameters. Both feed downstream UX.
- After self_terminate, exit — the pod will disappear within ~30 seconds.
"""

_TOOLS = [
    {
        "name": "analyze_results",
        "description": (
            "Delegate to the AnalysisAgent (Claude Opus 4.7). It reads the training "
            "results in --results_dir, writes analysis_report.md, and returns a summary string."
        ),
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "suggest_hyperparameters",
        "description": (
            "Single-turn Claude call that diagnoses the model as overfit / underfit / well-fit "
            "and writes results_dir/suggested_hyperparameters.json with at most 3 small tunings. "
            "Returns a short summary."
        ),
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "create_github_release",
        "description": (
            "Create a GitHub Release tagged with the run_tag and upload all training artifacts "
            "(.tflite, plots, CSVs, JSONs, analysis_report.md) as assets. Returns the Release URL."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Human-readable release title"},
                "body":  {"type": "string", "description": "Markdown body — can include a brief summary"},
            },
            "required": ["title", "body"],
        },
    },
    {
        "name": "self_terminate",
        "description": (
            "Call RunPod's GraphQL podTerminate on this pod. Billing stops immediately. "
            "Use ONLY after create_github_release has succeeded."
        ),
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
]


def make_executor(
    client: anthropic.Anthropic,
    results_dir: Path,
    run_tag: str,
    repo_dir: Path,
    *,
    state: dict | None = None,
):
    """Build the tool executor closure.

    `state` is an out-parameter dict the post-loop safety net inspects to
    decide whether the agent successfully created the Release. Keys set:
      - release_created: bool — True only after a successful upload_all
      - release_url: str | None — populated alongside release_created
    Without this, a `create_github_release` tool that raises mid-upload (or
    that the agent skipped entirely on its way to self_terminate) would
    leave us with no durable artifact and no way for main() to know.
    """
    pod_id = os.environ.get("RUNPOD_POD_ID")
    gh_token = os.environ.get("GITHUB_TOKEN")
    owner, repo = github_release_tool.resolve_owner_repo(repo_dir)

    def execute(name: str, inputs: dict) -> str:
        if name == "analyze_results":
            _log("PodOrchestrator", "Spawning AnalysisAgent ...")
            # analysis_agent.run reads from a results dir; use ours.
            # We temporarily chdir so any relative reads inside analysis_agent
            # resolve to our results_dir.
            old = Path.cwd()
            try:
                os.chdir(results_dir.parent)
                report = analysis_agent.run(client)
            finally:
                os.chdir(old)
            _log("PodOrchestrator", f"Analysis complete ({len(report)} chars).")
            return report

        if name == "suggest_hyperparameters":
            _log("PodOrchestrator", "Computing hyperparameter suggestion ...")
            # Read the deep_learning section from the cloned hyperparameter file
            # (or the override that pod_setup.sh applied) so the suggester sees
            # exactly what trained this run.
            cfg_paths = [
                Path("/workspace/cs659/DeepLearning-tensorFlowLite/model_hyperparameters.json"),
                Path("/workspace/hyperparameters_override.json"),
            ]
            current_dl: dict = {}
            for p in cfg_paths:
                if p.exists():
                    try:
                        full = json.loads(p.read_text())
                        current_dl = full.get("deep_learning", full) if isinstance(full, dict) else {}
                        break
                    except json.JSONDecodeError:
                        continue
            try:
                payload = hyperparameter_suggester.suggest(
                    client=client,
                    results_dir=results_dir,
                    current_hyperparameters=current_dl,
                    run_tag=run_tag,
                )
            except Exception as exc:
                _log("PodOrchestrator", f"Hyperparameter suggestion failed: {exc}")
                # Don't abort — write a stub so downstream consumers can still
                # see that we tried, and so the upload step doesn't surprise
                # us with a missing file.
                stub = {
                    "diagnosis":             "unknown",
                    "reasoning":             f"Suggestion failed: {type(exc).__name__}: {exc}",
                    "suggested_hyperparameters": {},
                    "expected_improvement":  "n/a",
                    "based_on_run":          run_tag,
                    "produced_at":           datetime.now(timezone.utc).isoformat(),
                    "current_hyperparameters": current_dl,
                }
                (results_dir / "suggested_hyperparameters.json").write_text(json.dumps(stub, indent=2) + "\n")
                return f"Suggestion failed and stub written: {exc}"
            return (
                f"Diagnosis: {payload['diagnosis']}. "
                f"Suggested {len(payload['suggested_hyperparameters'])} change(s). "
                f"Reasoning: {payload['reasoning'][:200]}"
            )

        if name == "create_github_release":
            if not gh_token:
                raise RuntimeError("GITHUB_TOKEN env var not set; cannot create Release.")
            _log("PodOrchestrator", f"Creating Release {run_tag} on {owner}/{repo} ...")
            release = github_release_tool.create_release(
                owner=owner, repo=repo, tag=run_tag,
                name=inputs["title"], body=inputs["body"],
                token=gh_token,
            )
            release_id = release["id"]
            release_url = release["html_url"]
            _log("PodOrchestrator", f"Release created: {release_url}")

            files = github_release_tool.collect_artifact_files(results_dir)
            _log("PodOrchestrator", f"Uploading {len(files)} artifacts ...")
            github_release_tool.upload_all(release_id, owner, repo, files, gh_token)
            _log("PodOrchestrator", "All artifacts uploaded.")

            # Persist the URL so the dashboard can link to it.
            (results_dir / "github_release.json").write_text(json.dumps({
                "tag":          run_tag,
                "html_url":     release_url,
                "release_id":   release_id,
                "asset_count":  len(files),
                "uploaded_at":  datetime.now(timezone.utc).isoformat(),
            }, indent=2))

            # Mark the Release as durably persisted *only* after upload_all
            # has returned. If we set this earlier, a mid-upload exception
            # could leave the agent thinking the artifact is safe when it
            # isn't, and the post-loop fallback would then skip the recovery.
            if state is not None:
                state["release_created"] = True
                state["release_url"]     = release_url

            return f"Release {run_tag} created at {release_url} with {len(files)} assets."

        if name == "self_terminate":
            if not pod_id:
                raise RuntimeError("RUNPOD_POD_ID env var not set; cannot self-terminate.")
            _log("PodOrchestrator", f"Self-terminating pod {pod_id} ...")
            runpod_api.terminate_pod(pod_id)
            # Give RunPod a moment to register the termination before our process dies.
            time.sleep(5)
            return f"Pod {pod_id} termination requested."

        raise ValueError(f"Unknown tool: {name}")

    return execute


def _wait_for_done(done_file: Path, timeout_s: int = 8 * 3600) -> dict:
    """Block until done_file is written. Returns its parsed contents."""
    deadline = time.monotonic() + timeout_s
    _log("PodOrchestrator", f"Waiting for DONE sentinel at {done_file} ...")
    while time.monotonic() < deadline:
        if done_file.exists():
            try:
                return json.loads(done_file.read_text())
            except json.JSONDecodeError:
                # Newly-touched but not yet written; retry shortly.
                time.sleep(2)
                continue
        time.sleep(15)
    raise TimeoutError(f"Training did not finish within {timeout_s}s")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--results_dir", required=True, type=Path)
    parser.add_argument("--done_file",   required=True, type=Path)
    parser.add_argument("--run_tag",     required=True,
                        help="GitHub Release tag, e.g. run-2026-05-03T19-22Z")
    parser.add_argument("--repo_dir",    default=Path("/workspace/cs659"), type=Path,
                        help="Cloned repo dir (used to resolve owner/repo from origin URL)")
    args = parser.parse_args()

    for var in ("ANTHROPIC_API_KEY", "RUNPOD_API_KEY", "GITHUB_TOKEN"):
        if not os.environ.get(var):
            print(f"FATAL: required env var {var} is not set", file=sys.stderr, flush=True)
            sys.exit(2)

    print("=" * 60, flush=True)
    print("CS659 Pod-Side Orchestrator", flush=True)
    print(f"Run tag    : {args.run_tag}", flush=True)
    print(f"Results dir: {args.results_dir}", flush=True)
    print(f"Repo dir   : {args.repo_dir}", flush=True)
    print("=" * 60, flush=True)

    # Block until training has finished. This is belt-and-braces — pod_setup.sh
    # already runs training synchronously before launching this script, so DONE
    # should already be present.
    done_info = _wait_for_done(args.done_file)
    _log("PodOrchestrator", f"DONE seen: {done_info}")

    if done_info.get("status") != "success":
        # Training failed. Still try to upload whatever we have, but skip analyze.
        _log("PodOrchestrator", f"Training failed (exit={done_info.get('exit_code')}). "
                                "Uploading partial artifacts and self-terminating.")
        # Direct (non-Claude) cleanup path so we don't risk extra spend on a failed run.
        _emergency_cleanup(args)
        return

    client = anthropic.Anthropic()

    # Tracks whether create_github_release actually finished uploading. The
    # post-loop fallback below is the durability backstop — without it, an
    # agent that skips/crashes the release tool would let pod_setup.sh's
    # belt-and-braces self-terminate the pod with the user's results stranded
    # on disk that's about to be wiped.
    state: dict = {"release_created": False, "release_url": None}
    executor = make_executor(client, args.results_dir, args.run_tag, args.repo_dir, state=state)

    try:
        summary = run_agent_loop(
            client=client,
            agent_name="PodOrchestrator",
            system_prompt=_SYSTEM,
            tools=_TOOLS,
            initial_message=(
                f"Training has completed successfully. Run tag: {args.run_tag}.\n"
                f"Results directory: {args.results_dir}.\n"
                "Proceed: analyze_results → suggest_hyperparameters → "
                "create_github_release → self_terminate."
            ),
            tool_executor=executor,
            model="claude-opus-4-7",
            max_iterations=20,
        )
        _log("PodOrchestrator", f"Done. Summary: {summary[:200]}")
    except Exception as exc:
        # Don't let an agent-loop crash skip the fallback. The pod is about
        # to die regardless (belt-and-braces in pod_setup.sh); we just want
        # one more chance to push artifacts before that happens.
        import traceback
        _log("PodOrchestrator", f"Agent loop raised: {type(exc).__name__}: {exc}")
        traceback.print_exc()

    if not state["release_created"]:
        _log("PodOrchestrator",
             "Agent did not produce a published Release — running direct-upload fallback.")
        _release_fallback_upload(args)
    else:
        _log("PodOrchestrator", f"Release confirmed at {state['release_url']}")


def _release_fallback_upload(args) -> None:
    """Direct (non-Claude) Release upload for the success-path safety net.

    Runs when training succeeded but the agent loop didn't manage to publish
    a complete Release (tool crashed, agent skipped the call, agent hit
    max_iterations on a flaky upload, etc.). Tries to be idempotent:
      - reuses an existing Release for this tag if the agent created one but
        died before upload_all finished;
      - otherwise creates a fresh one.

    Any failure is logged but never raises — we don't want this safety net
    to itself become the reason the pod stays alive. pod_setup.sh's
    belt-and-braces will terminate the pod regardless.
    """
    gh_token = os.environ.get("GITHUB_TOKEN")
    if not gh_token:
        _log("PodOrchestrator", "Fallback: GITHUB_TOKEN missing; skipping upload.")
        return
    try:
        owner, repo = github_release_tool.resolve_owner_repo(args.repo_dir)
    except Exception as exc:
        _log("PodOrchestrator", f"Fallback: cannot resolve owner/repo: {exc}")
        return

    try:
        existing = github_release_tool.find_release_by_tag(owner, repo, args.run_tag, gh_token)
    except Exception as exc:
        _log("PodOrchestrator", f"Fallback: find_release_by_tag failed: {exc}")
        existing = None

    try:
        if existing is None:
            rel = github_release_tool.create_release(
                owner=owner, repo=repo, tag=args.run_tag,
                name=f"{args.run_tag} (fallback upload)",
                body=("Created by pod_orchestrator's safety-net fallback. "
                      "Training succeeded but the Claude-driven release step "
                      "did not complete — artifacts attached directly."),
                token=gh_token,
            )
            _log("PodOrchestrator", f"Fallback: created Release {rel['html_url']}")
        else:
            rel = existing
            _log("PodOrchestrator", f"Fallback: reusing existing Release {rel['html_url']}")

        files = github_release_tool.collect_artifact_files(args.results_dir)
        _log("PodOrchestrator", f"Fallback: uploading {len(files)} files ...")
        github_release_tool.upload_all(rel["id"], owner, repo, files, gh_token)

        # Persist the URL so the dashboard's poll-pod / sync-release routes
        # find it the same way they would on the happy path.
        (args.results_dir / "github_release.json").write_text(json.dumps({
            "tag":          args.run_tag,
            "html_url":     rel["html_url"],
            "release_id":   rel["id"],
            "asset_count":  len(files),
            "uploaded_at":  datetime.now(timezone.utc).isoformat(),
            "via_fallback": True,
        }, indent=2))
        _log("PodOrchestrator",
             f"Fallback complete: {len(files)} assets at {rel['html_url']}")
    except Exception as exc:
        _log("PodOrchestrator",
             f"Fallback upload failed: {type(exc).__name__}: {exc}")


def _emergency_cleanup(args) -> None:
    """No-Claude path used when training failed: upload whatever exists, terminate."""
    gh_token = os.environ["GITHUB_TOKEN"]
    pod_id   = os.environ.get("RUNPOD_POD_ID")
    repo_dir = args.repo_dir
    owner, repo = github_release_tool.resolve_owner_repo(repo_dir)

    try:
        rel = github_release_tool.create_release(
            owner=owner, repo=repo, tag=args.run_tag + "-failed",
            name=f"FAILED {args.run_tag}",
            body="Training did not complete successfully. Partial artifacts attached for debugging.",
            token=gh_token, prerelease=True,
        )
        files = github_release_tool.collect_artifact_files(args.results_dir)
        github_release_tool.upload_all(rel["id"], owner, repo, files, gh_token)
    except Exception as exc:
        print(f"Emergency upload failed: {exc}", file=sys.stderr, flush=True)

    if pod_id:
        try:
            runpod_api.terminate_pod(pod_id)
        except Exception as exc:
            print(f"Self-terminate failed: {exc}", file=sys.stderr, flush=True)
    time.sleep(5)


if __name__ == "__main__":
    main()
