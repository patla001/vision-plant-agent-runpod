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

### The agent dispatch model

```
User clicks Start
    ↓
Dashboard → POST /api/pipeline/start → spawns python agents/run_pipeline.py
    ↓
OrchestratorAgent (Opus 4.7) — has 8 tools, runs the full lifecycle
    ├── tool: provision_pod          → calls runpod_api.create_pod
    ├── tool: wait_for_pod_ready     → polls until SSH port opens
    ├── tool: launch_training        → SCP scripts to pod, run pod_setup.sh
    ├── tool: check_training_status  → SPAWNS MonitorAgent (Haiku 4.5) as subagent
    ├── tool: wait_minutes           → time.sleep between status checks
    ├── tool: download_results       → rsync /workspace/results to local
    ├── tool: terminate_pod          → calls runpod_api.terminate_pod
    └── tool: analyze_results        → SPAWNS AnalysisAgent (Opus 4.7) as subagent
```

Subagents are spawned by their parent's tool implementation as separate `client.messages.create()` calls. They have their own focused tools, system prompts, and iteration limits.

### Why three different models

| Agent | Model | Reason |
|-------|-------|--------|
| Orchestrator | `claude-opus-4-7` | High-stakes decisions — mistakes cost RunPod money |
| Monitor | `claude-haiku-4-5` | Simple SSH status checks, cheapest model |
| Analysis | `claude-opus-4-7` | Real reasoning over numerical results |

### State persistence

All inter-process state lives in two files in `results/`:
- `pipeline_state.json` — current step, status, errors, pod ID. Written atomically by Python via temp-file rename.
- `pipeline.log` — Python subprocess stdout/stderr.

The dashboard reads both via `/api/pipeline/status` (polled every 10 s) and `/api/pipeline/logs` (SSE every 2 s). Closing the browser tab does not interrupt the pipeline — state survives.

## Common Commands

**Dashboard dev server:**
```bash
cd dashboard && pnpm install && pnpm dev      # opens at localhost:3000
cd dashboard && pnpm typecheck                 # TypeScript check
```

**Run the pipeline manually (without dashboard):**
```bash
cd scripts && pip install -r requirements.txt
python agents/run_pipeline.py                  # requires .env with both API keys
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
