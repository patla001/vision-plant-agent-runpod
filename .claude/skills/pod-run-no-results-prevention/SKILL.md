---
name: pod-run-no-results-prevention
description: |
  Use this skill whenever the user reports a pod ran for hours but produced
  no GitHub Release / no downloadable .tflite / no artifacts. This is the
  most expensive failure mode in the project (one occurrence = ~$10–$20 of
  GPU time + a wasted day). Symptoms include: "the pod ran for X hours and
  there's nothing in the release", "training finished but dashboard still
  shows running-on-pod", "I can't find my .tflite", "no release found for
  run-tag X". This skill captures every known failure mode, where each is
  fixed in code, and the preflight + recovery checklist that prevents
  another occurrence.
---

# Pod-run-no-results prevention

## What "no results" means

After a successful training run, the orchestrator is supposed to:
1. analyze_results → write `analysis_report.md`
2. suggest_hyperparameters → write `suggested_hyperparameters.json`
3. create_github_release → upload every file in `/workspace/results/` to a Release tagged `<run_tag>`
4. self_terminate → call `runpod_api.terminate_pod(RUNPOD_POD_ID)`

If **any** step in (3) or (4) fails AND there's no fallback, the pod dies (manually or via timeout) with the artifacts still on `/workspace`. The disk is reaped with the pod. The user has nothing to show for hours of training.

## Every known failure mode (and where it's fixed)

| # | Failure | Detected at | Fix lives in |
|---|---|---|---|
| 1 | `RUNPOD_POD_ID` not in SSH session env → `self_terminate` raises `RuntimeError` → pod orphans, billing forever | After agent loop ends | `scripts/agents/laptop_bootstrap.py` `pod_id_export` injects it into the screen's env at launch. Dashboard's `dashboard/app/api/pipeline/restart-training/route.ts` does the same. |
| 2 | `GITHUB_TOKEN` lacks `Contents: write` → `create_release` returns HTTP 403 → no Release created | 6+ hours into the run | `scripts/agents/laptop_bootstrap.py::_preflight_github_token()` runs **before** pod provisioning. Fail fast at second 0. |
| 3 | Agent loop crashes / hits max_iterations / Claude API outage → no `create_github_release` ever runs | After agent loop ends | `scripts/agents/pod_orchestrator.py::_release_fallback_upload()` — non-Claude direct upload. Tracks `state["release_created"]` so the fallback only fires when needed. |
| 4 | `pod_setup.sh` aborts via `set -e` before reaching the bottom-of-file terminate block (apt fails, pip fails, training crashes) | Pre-orchestrator | `scripts/pod_setup.sh` `trap self_terminate_safety_net EXIT` registered at top. Fires on every exit path. |
| 5 | Training runs all 25 epochs even when overfitting → wasted GPU time | During training | `DeepLearning-tensorFlowLite/train_export_tflite.py:308` switched ES to `monitor="val_loss", min_delta=1e-3` so the patience counter actually accumulates on overfit-prone runs. |
| 6 | Pod terminated externally / RunPod evicts → laptop's `pipeline_state.json` still says `running-on-pod` forever | Dashboard refresh | `dashboard/app/api/pipeline/poll-pod/route.ts` returns `inferredStatus: "unknown"` or `"partial"`; `PipelineControl.tsx` renders a red termination banner with recovery actions. |
| 7 | Reset wipes `pipeline_state.json` after a failed run → user can't tell whether prior run saved results | Home page after reset | `dashboard/lib/last-run.ts` writes `results/last_run.json` (separate file, survives reset). Home-page card surfaces the outcome. |
| 8 | Bootstrap dies right after `wait_for_pod` because pod's sshd not really ready (Connection closed by remote host on first SCP) | Pre-training | `scripts/agents/laptop_bootstrap.py` 15 s settle sleep + transient-error retry on `_scp` / `_ssh`. |
| 9 | `apt-get install screen` times out on slow RunPod mirrors → bootstrap fails before pod ever runs anything | Pre-training | Bootstrap uses `command -v screen >/dev/null \|\| (apt-get …)` short-circuit + 300 s timeout. |

## Preflight checklist (apply BEFORE every fresh run)

```bash
# 1. Confirm GITHUB_TOKEN has Contents:write on the target repo.
#    The bootstrap will check too, but useful to verify standalone:
TOKEN=$(grep '^GITHUB_TOKEN=' .env | cut -d= -f2-)
curl -sS -H "Authorization: Bearer $TOKEN" \
  https://api.github.com/repos/patla001/vision-plant-agent-runpod \
  | python3 -c "import sys,json; d=json.load(sys.stdin); p=d.get('permissions',{}); print('push:', p.get('push'), 'admin:', p.get('admin'))"
# Expected: "push: True"
# If "push: False" → fix token scope in https://github.com/settings/tokens
#                    (classic: tick `repo`. fine-grained: Contents: Read and write.)

# 2. Confirm no orphan pods are billing.
#    Use the dashboard's "🔍 Check for stray pods" button on the home page,
#    or query directly:
#    (do this via the dashboard's /api/pipeline/list-pods route, which
#    handles auth via Authorization header — never embed the key in URL.)

# 3. Confirm local pipeline_state.json is clean (no stale "running" entry).
ls results/pipeline_state.json 2>/dev/null && echo "STALE — reset before starting new run"
```

## During-run early-warning signals

The dashboard's `PodLiveLog` panel (auto-polls every 10 s) is the primary instrument. Watch for:
- **`HTTPError: 403`** in `orchestrator.log` → token scope issue. Stop the run, fix the token, restart on same pod (results are still on disk).
- **`RUNPOD_POD_ID env var not set`** in `orchestrator.log` → critical. Manually SCP `/workspace/results/` to laptop AND manually terminate the pod via RunPod console.
- **`val_loss` monotonically rising for 3+ epochs while `train_loss` falls** → overfitting; ES should fire within `early_stopping_patience` epochs.

## Recovery when a run still produces no results

1. **First action: don't terminate the pod.** While the pod is alive, `/workspace/results/` is recoverable.
2. **Read the dashboard's `PodLiveLog` orchestrator tab** to identify which step failed.
3. **SCP the results to laptop** before any other action:
   ```bash
   scp -rq -P <port> -o StrictHostKeyChecking=no \
     root@<ip>:/workspace/results/. \
     results/<run_tag>/
   ```
4. **Manually create the Release** with `gh release create <run_tag> results/<run_tag>/* --repo patla001/vision-plant-agent-runpod`.
5. **Then** terminate the pod: query the RunPod GraphQL `podTerminate` mutation with `Authorization: Bearer <key>` (never embed the key in the URL).
6. **Update `last_run.json`** with `outcome: "completed_synced"` and the release URL so the dashboard reflects reality.

## Token-permission gotcha (learned the hard way)

**`permissions.push: True` on `GET /repos/{owner}/{repo}` does NOT mean the token can write.** That field reports the *authenticated user's* role on the repo — for a fine-grained PAT issued to the repo owner, it'll always show `admin: True` regardless of what the token is actually scoped for. The token can be (and often is) tighter than the user.

The only reliable preflight is to **actually attempt the write**:

```python
# POST a draft release (no tag is materialized for drafts), check 201.
# If 201: immediately DELETE it.
# If 403: token genuinely lacks Contents:write — fail fast.
```

`scripts/agents/laptop_bootstrap.py::_preflight_github_token()` does this. If you find yourself adding a permission check that uses `permissions.<flag>` from a `GET /repos` response, you're about to repeat the bug that lost the user a 6-hour run.

The cheap sanity-check (GET /repos with token, look for 401/404) is still worth doing first — surfaces invalid/expired tokens with cleaner errors before the write attempt.

## What NOT to do

- **Do NOT terminate the pod before SCP-ing results.** The disk is destroyed with the pod and there is no undo.
- **Do NOT trust an `inferredStatus: "done"` from `poll-pod` without checking the Release on GitHub directly** — `done` only requires `release && !release.draft`, which an empty stub Release would satisfy.
- **Do NOT add side-effects to `poll-pod` GET handlers** to "auto-recover" stale state. Polled GETs can race with each other and corrupt state.
- **Do NOT lower `early_stopping_patience` below 3.** With val_loss as the monitor, 5 is conservative; 3 is the floor before random batch noise causes premature stops.
- **Do NOT try to fix the orchestrator by hardcoding `RUNPOD_POD_ID` in `pod_setup.sh`.** The bootstrap is the right place — it knows the id and can pass it via the screen's env without leaking it into log files.

## Manual verification after applying any fix

```bash
# After a successful end-to-end run, every one of these should succeed:
gh release view <run_tag> --repo patla001/vision-plant-agent-runpod
ls results/<run_tag>/plant_classifier_deep_learning.tflite
ls results/<run_tag>/suggested_hyperparameters.json
ls results/<run_tag>/analysis_report.md
cat results/last_run.json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['outcome'])"
# Expected outcome: completed_synced
```

If any of these fail, the relevant fix from the table above isn't in effect. Don't paper over it — find the specific gap and address it explicitly.
