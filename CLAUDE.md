# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CS659 multi-agent ML pipeline that trains a MobileNetV2 plant classifier on PlantNet-300K using a remote NVIDIA RTX 4090 (RunPod), driven from a Next.js dashboard. Three Anthropic-SDK agents collaborate to provision the pod, monitor training, download results, terminate billing, and produce an analysis report — all from a single browser button click.

## Repository Layout

```
.
├── dashboard/                          Next.js 14 + Three.js results & control UI
│   ├── app/
│   │   ├── api/pipeline/{start,abort,status,logs}/  Pipeline lifecycle endpoints
│   │   ├── api/{results,image}/                      Read training artifacts
│   │   └── page.tsx, layout.tsx                      Main UI
│   └── components/                     React components (Three.js scenes, charts)
├── scripts/                            RunPod orchestration + multi-agent system
│   ├── agents/
│   │   ├── orchestrator.py             Top-level Claude agent (Opus 4.7)
│   │   ├── monitor_agent.py            SSH status checker (Haiku 4.5)
│   │   ├── analysis_agent.py           Results interpreter (Opus 4.7)
│   │   ├── base_agent.py               Shared agentic loop with prompt caching
│   │   ├── pipeline_state.py           Atomic state-file writer
│   │   └── _constants.py               Tunable configuration values
│   ├── runpod_api.py                   GraphQL client (create/poll/terminate)
│   ├── pod_setup.sh                    Runs ON the pod: wget dataset, flatten, train
│   └── tests/                          pytest tests for state-management code
└── DeepLearning-tensorFlowLite/        Original CNN training scripts (run on the pod)
```

## Architecture

### Pod-side detached run model

The orchestrator runs **on the training pod itself**, inside a `screen` session, so the user's laptop can shut down anytime after the bootstrap completes.

```
User clicks Start
    ↓
Dashboard → POST /api/pipeline/start → spawns laptop_bootstrap.py
    ↓
laptop_bootstrap.py (NOT a Claude agent — pure Python):
    1. provision pod via runpod_api.create_pod
    2. wait for SSH
    3. SCP .env, agents/, pod_setup.sh, training_wrapper.py to pod
    4. SSH: `setsid env RUN_TAG=... screen -dmS cs659 bash /workspace/pod_setup.sh`
    5. write pipeline_state.json with status="running-on-pod"
    6. exit (laptop free to disconnect)
        ↓
pod_setup.sh (running in screen 'cs659' on pod):
    1. apt + pip installs (training + agent reqs)
    2. wget + unzip + flatten PlantNet-300K
    3. python training_wrapper.py (foreground; writes DONE when complete)
    4. python pod_orchestrator.py
        ↓
PodOrchestratorAgent (Opus 4.7, ON THE POD):
    ├── tool: analyze_results       → SPAWNS AnalysisAgent (Opus 4.7) as subagent
    ├── tool: create_github_release → uploads .tflite + plots + CSVs as Release assets
    └── tool: self_terminate        → calls RunPod GraphQL podTerminate on its own pod_id
```

Two Claude agents in the loop now: the pod orchestrator and the analysis subagent. The previous laptop-side `MonitorAgent` is gone — the pod-side orchestrator reads local files directly so SSH-based monitoring isn't needed.

### Reattach flow (user comes back hours later)

Dashboard on load:
1. Reads `pipeline_state.json` for `pod_id` + `run_tag`
2. Calls `/api/pipeline/poll-pod` which combines:
   - RunPod GraphQL: is the pod still alive?
   - GitHub API: does Release `<run_tag>` exist?
3. Renders a status panel: bootstrapping / training / uploading / done / unknown
4. When state is "done", a Sync button calls `/api/pipeline/sync-release` to download all Release assets to local `results/<run_tag>/`, then transitions the dashboard to the regular results view (TrainingCurves, ConfusionMatrix, etc.)

### State persistence

`results/pipeline_state.json` is the source of truth on the local laptop. It carries `pod_id`, `run_tag`, `pod_ip`, `pod_port`, `screen_session`, `color_correct`, `status`. The dashboard polls `/api/pipeline/status` (local-only) and `/api/pipeline/poll-pod` (RunPod + GitHub). The pod-side orchestrator does NOT write to this file — once the pod is detached, the only durable state is the GitHub Release.

## Common Commands

**Dashboard dev server:**
```bash
cd dashboard && pnpm install && pnpm dev      # opens at localhost:3000
cd dashboard && pnpm typecheck                 # TypeScript check
```

**Run the pipeline manually (without dashboard):**
```bash
cd scripts && pip install -r requirements.txt
python agents/laptop_bootstrap.py               # requires .env with all 3 keys
# (Legacy laptop-resident orchestrator: agents/run_pipeline.py — kept for reference, not used by dashboard)
```

**Run the tests:**
```bash
python -m pytest scripts/tests/ -v
```

**Verify environment:**
```bash
cd scripts/agents && python -c "from _constants import ORCHESTRATOR_MODEL; print(ORCHESTRATOR_MODEL)"
```

## Key Workflows

### Adding a new agent tool

1. Add the tool definition (name, description, input_schema) to the agent's `_TOOLS` list
2. Add a branch in the agent's tool executor function
3. Update the agent's system prompt to mention the new tool
4. If the tool needs to be called from the dashboard's `/api/pipeline/abort` route or similar, also expose state via `pipeline_state.write_state(..., new_field=value)`

### Adjusting training hyperparameters

These are read from `DeepLearning-tensorFlowLite/model_hyperparameters.json` by `train_export_tflite.py`. Both the agent system and the manual training scripts honor the same JSON. CLI flags override JSON values.

### Adding a new dashboard API route

1. Create `dashboard/app/api/<name>/route.ts` exporting a `GET` or `POST` async function
2. If reading from `results/`, validate path inputs against a regex whitelist + `path.relative` (see `/api/image` for the pattern)
3. If executing subprocess, use list-form args (never `shell=True`)
4. If reading log/state files frequently, cache by mtime (see `/api/pipeline/status` and `/api/results`)

## Things to know

### Prompt caching

All agents use `cache_control: ephemeral` on their system prompts (see `base_agent.py`). The orchestrator's loop calls `messages.create` 100+ times during a 4-hour run, so caching the ~3 KB system prompt is significant.

### Adaptive thinking

Default `thinking: {type: "adaptive"}` is on for all agents per the `claude-api` skill recommendations. Don't add `budget_tokens` — it's deprecated on Opus 4.7.

### Iteration limits

Constants in `scripts/agents/_constants.py`:
- Orchestrator: 200 (covers ~96 monitoring cycles + setup/teardown)
- Monitor: 10 (only does a handful of SSH probes per call)
- Analysis: 15 (a few file reads + one write)

If you change the monitoring interval, recompute the orchestrator iteration cap.

### Security

See `SECURITY.md` for the threat model and deliberate tradeoffs (especially `StrictHostKeyChecking=no` on SSH, no auth on `/api/pipeline/*` routes — both intentional for local-only single-user dev).

## What NOT to do

- Don't add `python` to the `start` route — use the Python binary resolution helper that probes `python3` first (see `dashboard/app/api/pipeline/start/route.ts`)
- Don't pass `shell=True` to any subprocess call — always use list-form args
- Don't write CSV-parsing or log-parsing without an mtime cache — those endpoints are polled frequently
- Don't store API keys in any file other than `.env` (which is gitignored)
- Don't commit anything in `results/`, `dashboard/node_modules/`, or `*.tflite`/`*.joblib` — these are gitignored for good reasons
