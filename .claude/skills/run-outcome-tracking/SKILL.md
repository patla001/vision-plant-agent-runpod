---
name: run-outcome-tracking
description: |
  Use this skill whenever the user reports that the dashboard "doesn't tell
  them whether their last run actually saved results", or asks variations
  like "did it complete?", "are there results to download?", "I don't know
  if my training finished or just died". The underlying gap: pipeline_state.json
  is overwritten on every new start (and wiped by /api/pipeline/reset),
  leaving no durable record of whether the *previous* run produced saveable
  artifacts. The fix is a separate results/last_run.json that survives
  resets and is rendered as a card on the idle home page.
---

# Run-outcome tracking

## The gap this addresses

`results/pipeline_state.json` describes the *currently active* run. It is:
- Overwritten when the user clicks Start (a new state replaces the old).
- Deleted by `POST /api/pipeline/reset`.
- Never touched by the pod itself — when the pod terminates, no callback
  rewrites this file.

So once the user starts a new run, mashes the reset button, or refreshes
after a crash, **all trace of the prior run's outcome is gone**. The user
has no way to look at the dashboard and answer "did my last run save
anything, or did it die before uploading?".

## Outcomes worth distinguishing

A run can end in several distinct states; the user genuinely wants to
tell them apart:

| Outcome                 | When                                             | Surface as                       |
|-------------------------|--------------------------------------------------|----------------------------------|
| `completed_synced`      | Release published + assets downloaded locally   | ✅ Completed — results saved     |
| `completed_unsynced`    | Release published, user hasn't synced yet      | 📦 Release ready to sync         |
| `partial_upload`        | Pod died mid-upload (draft Release exists)     | ⚠️ Partial upload                |
| `terminated_no_results` | Pod gone, no Release at all                    | ❌ Pod terminated — no results   |
| `aborted_by_user`       | User clicked Abort                             | 🛑 Aborted by you                |
| `failed_pre_pod`        | laptop_bootstrap.py crashed before any pod     | 💥 Failed before pod started     |

## The fix pattern

### 1. Storage

`results/last_run.json` — written via the helper at
`dashboard/lib/last-run.ts`:

```ts
export interface LastRunRecord {
  run_tag:        string;
  outcome:        LastRunOutcome;
  finished_at:    string;
  pod_id?:        string;
  color_correct?: string;
  hp_mode?:       string;
  release_url?:   string;
  asset_count?:   number;
  message?:       string;
}
```

This file is **separate** from pipeline_state.json on purpose: the reset
endpoint deletes pipeline_state.json + pipeline.log, but not last_run.json.

### 2. Where outcomes get written

- `sync-release/route.ts` — on success, writes `completed_synced` with
  release_url + asset_count.
- `abort/route.ts` — writes `aborted_by_user` whenever a run_tag exists
  in state. Skipped when abort fires before a run_tag was ever recorded.
- `finalize/route.ts` (NEW) — explicit endpoint for the dashboard to
  record `terminated_no_results` / `partial_upload` / `completed_unsynced`
  when poll-pod observes the definitive end-state but no other route is
  in the natural call path. Always called *before* reset, never after.

### 3. Surface

`/api/pipeline/last-run` is a simple GET that reads last_run.json (or
returns null). The home-page idle view fetches it on mount and renders
a small card above the Hero with:

- Icon + title for the outcome (color-coded).
- Run tag, finished_at, color_correct, hp_mode.
- An action button matching the outcome:
  - `completed_synced` → ⬇ Download .tflite
  - `completed_unsynced` / `partial_upload` → ⬇ Sync release
  - `terminated_no_results` / `aborted_by_user` → no download (the
    rerun-with-same-choices path comes from the hydrated pickers below)
- Optional ⧉ "View on GitHub" link if release_url is present.

The card refreshes when status transitions to idle (i.e., right after
"Return to home" is clicked from the pod-terminated banner).

## Critical files

- `dashboard/lib/last-run.ts` — the only writer/reader of last_run.json. Keep it minimal: write is best-effort (failures must not break the calling route's primary response), reads return null on any error.
- `dashboard/app/api/pipeline/last-run/route.ts` — GET endpoint, no side effects.
- `dashboard/app/api/pipeline/finalize/route.ts` — POST endpoint, validates the outcome against `VALID_OUTCOMES`. Refuses if no run_tag is in state.
- `dashboard/app/api/pipeline/sync-release/route.ts` — writes completed_synced.
- `dashboard/app/api/pipeline/abort/route.ts` — writes aborted_by_user when a run_tag exists.
- `dashboard/app/api/pipeline/reset/route.ts` — must NOT delete last_run.json (only STATE + LOG).
- `dashboard/components/PipelineControl.tsx` — fetches last-run on mount + on status→idle transition; renders the home-page card; the pod-terminated banner's "Return to home" calls `handleResetToHome("terminated_no_results" | "partial_upload")` which finalize-then-resets.

## What NOT to do

- **Do not write last_run.json from inside `/api/pipeline/poll-pod`.**
  poll-pod is a polled GET; side-effects on every poll are racy and
  surprising. The dashboard observes the inferred state, then explicitly
  calls finalize when the user takes an action.
- **Do not delete last_run.json on reset.** That defeats the entire
  purpose — the user is resetting *because* a run ended, and the reset
  is the moment they most want a durable record of what just happened.
- **Do not infer outcomes from pipeline_state.json alone.** That file
  doesn't know the pod's true state. Combine pod state + Release
  presence (poll-pod's `inferredStatus`) before deciding.
- **Do not auto-finalize from a `useEffect`.** Finalize must be tied to
  a user action so the recorded message reflects the user's intent
  ("I am abandoning this run") rather than a transient API blip.

## Manual verification

```bash
# 1. Force a pod-terminated state (terminate pod via RunPod console).
# 2. Refresh dashboard — pod-terminated banner appears.
# 3. Click "Return to home".
#    → Expect POST /api/pipeline/finalize with outcome: terminated_no_results
#    → Expect POST /api/pipeline/reset
#    → State transitions to idle.
# 4. Home page now shows a red ❌ "Pod terminated — no results saved" card
#    above the hero, with the run_tag and last color/hp choices.
# 5. cat results/last_run.json — confirm the file persists.
# 6. Click Start to launch a new run; the prior last_run.json is preserved
#    until the new run's outcome overwrites it.
```
