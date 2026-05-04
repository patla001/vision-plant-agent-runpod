---
name: pod-terminated-recovery
description: |
  Use this skill whenever the user reports that the dashboard is "stuck"
  showing a running-on-pod state after the RunPod pod has been terminated
  (manually, by self_terminate, by orphan cleanup, by RunPod eviction, or
  because the orchestrator crashed). Symptoms include: dashboard still
  shows "Run on pod (detached) — Training on pod" but RunPod console shows
  the pod EXITED/gone, or the user complains "I terminated the pod but the
  dashboard didn't update / didn't reset / didn't show me what happened".
  This is a recurring bug — the laptop's results/pipeline_state.json is the
  source of truth for the dashboard, and pod termination on RunPod's side
  does NOT propagate back into that file.
---

# Pod-terminated recovery

## The bug pattern

`results/pipeline_state.json` is **only** written by:
1. `dashboard/app/api/pipeline/start/route.ts` (initial state)
2. `scripts/agents/laptop_bootstrap.py` (during provisioning)
3. `scripts/agents/pipeline_state.py::write_state` (laptop-side; not used after the bootstrap exits)
4. `dashboard/app/api/pipeline/{abort,reset,sync-release,restart-training}/route.ts` (user-driven)

It is **never** automatically rewritten when the pod ends — neither by
`pod_orchestrator.self_terminate()`, nor by manual RunPod console
termination, nor by `cleanup-orphans`. So the local file is stale the
moment the pod dies, and the dashboard renders whatever `status` is on
disk forever (typically `"running-on-pod"`).

The dashboard infers the *real* state via `/api/pipeline/poll-pod`, which
combines:
- RunPod GraphQL `pod(input:{podId}) { desiredStatus runtime { ... } }`
- GitHub `GET /repos/:owner/:repo/releases/tags/:run_tag`

It returns `inferredStatus`:
- `bootstrapping` — no pod_id yet
- `training` — pod RUNNING, no Release
- `uploading` — pod RUNNING, draft Release
- `partial` — pod GONE, draft Release (orchestrator died mid-upload)
- `done` — published Release (regardless of pod state)
- `unknown` — pod GONE, no Release (the "pod terminated, no results" case)

## How to fix when the user hits this

If the dashboard is showing the stale `running-on-pod` view and `podPoll`
reports `inferredStatus: "unknown"` or `"partial"` with `podAlive: false`,
the UI must:

1. Render a prominent termination banner (red, top of card).
2. Tell the user explicitly that the pod is gone and whether anything
   was uploaded.
3. Offer recovery actions:
   - **Run again with same color correction** — `handleFreshStart`,
     which `abort`s any leftover, `reset`s state, and re-`start`s with
     the current `colorCorrect` + `hpMode` UI state.
   - **Return to home** — `abort` + `reset` + `setState({status:"idle"})`.
     Wipes `pipeline_state.json` and `pipeline.log` but keeps the user
     on the dashboard so the home-page pickers (already hydrated from
     prior state) let them tweak settings.
   - **Hyperparameter picker** — default / AI suggested / manual,
     visible in the banner so the user can change strategy before re-run.
4. For `partial`: surface the draft-release URL and a "Try to sync
   partial assets" button (calls `/api/pipeline/sync-release`).

## Critical files

- `dashboard/app/api/pipeline/poll-pod/route.ts` — owns the `inferredStatus` mapping. `partial` was added so the UI can distinguish "pod died mid-upload" from "still uploading".
- `dashboard/app/api/pipeline/start/route.ts` — persists `color_correct`, `hp_mode`, `hyperparameters` into `pipeline_state.json` so the picker can be re-hydrated after a failure.
- `dashboard/components/PipelineControl.tsx` — owns the banner rendering. The `podTerminated` flag is computed as `podAlive === false && (inferred === "unknown" || inferred === "partial")`. Initial picker state is hydrated from `initialState.color_correct` / `initialState.hp_mode` / `initialState.hyperparameters` in `useState` initializers (NOT in a `useEffect` — that would clobber user edits).
- `dashboard/app/api/pipeline/reset/route.ts` — wipes `pipeline_state.json` and `pipeline.log`, used by "Return to home".
- `dashboard/app/api/pipeline/abort/route.ts` — accepts both `running` and `running-on-pod` and treats `POD_NOT_FOUND` as success. Required for the recovery flow to be idempotent.

## What NOT to do

- **Do not add a side-effecting write to `/api/pipeline/poll-pod`.** It is
  a GET, polled every 60s, and writing to disk on every poll is racy and
  surprising. Let the UI surface the inferred state instead.
- **Do not auto-reset on pod termination.** The user wants a chance to
  see what happened before the state is wiped — the recovery must be
  explicit (button click), not silent.
- **Do not hydrate UI choices in a `useEffect`.** That fires after the
  user might have already typed into the picker and would clobber their
  edits. Use `useState` initializer functions instead.
- **Do not assume `RUNPOD_POD_ID` is still valid** when calling RunPod
  GraphQL during recovery — it's the *prior* pod's id and the pod may
  return `POD_NOT_FOUND`. The abort route already treats that as success;
  preserve that behavior.

## Manual verification

```bash
# 1. Force the bad state: edit pipeline_state.json status to "running-on-pod"
#    while the actual pod is gone (or terminate the real pod via the RunPod console).
# 2. Refresh the dashboard.
# 3. Within ~60s the pod-terminated banner should render with three buttons.
# 4. Click "Return to home" → the home page should show with the prior
#    color-correction selection still set in the dropdown.
# 5. Click "Run again with same color correction" → a new pod is provisioned
#    using the same colorCorrect; banner disappears.
```
