# Vision-Plant Multi-Agent Training Pipeline

> **SDSU Spring 2026 — CS659 Project**
> Group members: Ezer, Mason, Gigi

A browser-driven, multi-agent system that trains a MobileNetV2 plant classifier on the **PlantNet-300K** dataset using a **remote NVIDIA RTX 4090** (RunPod), with three Anthropic-SDK agents collaborating to provision the GPU, monitor training, download results, terminate the pod, and produce an analysis report — all from a single click in a Next.js dashboard.

## What this project demonstrates

- **Multi-agent AI systems** with the Anthropic SDK — Orchestrator + subagents
- **Remote GPU lifecycle automation** via RunPod's GraphQL API
- **CNN training at scale** — 306K plant images, 1,081 species, MobileNetV2 → TFLite
- **Modern web UI** — Next.js 14 App Router, Three.js scenes, SSE live logs
- **Operability** — abort button, structured error capture, diagnostics panel

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser (localhost:3000)                                         │
│  Next.js dashboard with Three.js neural-network background        │
└────────────────────────────┬─────────────────────────────────────┘
                             │
            ┌────────────────┼────────────────┐
            ▼                ▼                ▼
    /api/pipeline/start  /status (poll)  /logs (SSE)
            │                │                │
            ▼                └────────────────┘
    spawns python subprocess
            │
            ▼
┌──────────────────────────────────────────────────────────────────┐
│  Orchestrator Agent  (Claude Opus 4.7, adaptive thinking)         │
│  ├── tool: provision_pod        ──▶ RunPod GraphQL                │
│  ├── tool: launch_training      ──▶ SSH to pod, start screen      │
│  ├── tool: check_training_status ─▶ ┌──────────────────────────┐  │
│  │                                  │ Monitor Subagent (Haiku) │  │
│  │                                  │ checks DONE sentinel     │  │
│  │                                  └──────────────────────────┘  │
│  ├── tool: download_results     ──▶ rsync                         │
│  ├── tool: terminate_pod        ──▶ RunPod GraphQL                │
│  └── tool: analyze_results      ──▶ ┌──────────────────────────┐  │
│                                     │ Analysis Subagent (Opus) │  │
│                                     │ writes analysis_report.md│  │
│                                     └──────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  RunPod RTX 4090 Pod (ephemeral, ~3–4 hours per run)              │
│  ├── wget plantnet_300K.zip (31.7 GB) → unzip → flatten symlinks │
│  ├── pip install requirements                                     │
│  └── screen -dmS train_cnn  python train_export_tflite.py         │
└──────────────────────────────────────────────────────────────────┘
```

## Setup

**Prerequisites:**
- Node.js 18+ and `pnpm` (or npm)
- Python 3.10+ with `pip`
- A [RunPod](https://www.runpod.io/) account with credits + read/write API key
- An [Anthropic](https://console.anthropic.com/) API key
- Your SSH public key registered in RunPod settings

**Install:**
```bash
# Dashboard
cd dashboard && pnpm install

# Pipeline (Python)
cd scripts && pip install -r requirements.txt

# Configure secrets
cd .. && cp .env.example .env
# Edit .env to fill in RUNPOD_API_KEY and ANTHROPIC_API_KEY
```

**Run:**
```bash
cd dashboard && pnpm dev
# Open http://localhost:3000 → click ⚡ Start Training Pipeline
```

A complete training run takes about **3–4 hours** and costs roughly **$3–4** in RunPod GPU time. You can close the browser tab and come back — state persists in `results/pipeline_state.json`.

## Tech stack

| Layer | Technology |
|-------|-----------|
| ML | TensorFlow 2.x, MobileNetV2, scikit-learn, scikit-image |
| Agents | Anthropic SDK (Python), Claude Opus 4.7 + Haiku 4.5 |
| GPU | RunPod (NVIDIA RTX 4090, 24 GB VRAM, 150 GB disk) |
| Dashboard | Next.js 14 (App Router), TypeScript, Tailwind CSS |
| Visualization | Three.js, Recharts |
| Runtime | Python 3.10+, Node.js 18+, pnpm |

## Project layout

| Directory | Contents |
|-----------|---------|
| `dashboard/` | Next.js 14 app — UI + API routes |
| `scripts/agents/` | Multi-agent system (Orchestrator, Monitor, Analysis) |
| `scripts/runpod_api.py` | RunPod GraphQL client |
| `scripts/pod_setup.sh` | Runs *on* the pod — downloads dataset, starts training |
| `DeepLearning-tensorFlowLite/` | The actual CNN training scripts (MobileNetV2 + TFLite export) |
| `scripts/tests/` | pytest unit tests |
| `CLAUDE.md` | Architecture guide for future Claude Code sessions |
| `SECURITY.md` | Documented security tradeoffs (SSH host keys, etc.) |
| `CODE_REVIEW.md` | Initial code review with categorized findings |

## Key features

- **Abort button** — terminates the pod and kills the local Python process in ~1 second when you need to stop a runaway run
- **Diagnostics panel** — counts errors and warnings from the log, expandable for context lines
- **Live log filter** — toggle between All / Errors / Warnings, saved across page reloads
- **Cost ticker** — real-time estimate of how much the current run has cost so far
- **State persistence** — close the browser, reopen later, the dashboard picks up exactly where you left off
- **Structured Python tracebacks** — when training fails, the full traceback is captured to `pipeline_state.json` and displayed in a dedicated terminal pane

## Documentation

| File | When to read it |
|------|----------------|
| [`CLAUDE.md`](CLAUDE.md) | Architecture overview, common commands, key workflows |
| [`SECURITY.md`](SECURITY.md) | Threat model, security tradeoffs, what's intentionally relaxed |
| [`CODE_REVIEW.md`](CODE_REVIEW.md) | Categorized findings from the initial review |
| [`DeepLearning-tensorFlowLite/CLAUDE.md`](DeepLearning-tensorFlowLite/CLAUDE.md) | Specific guide for the CNN training scripts |

## Acknowledgments

- **PlantNet-300K** dataset: [Garcin et al., NeurIPS 2021](https://zenodo.org/records/5645731)
- **MobileNetV2**: [Sandler et al., 2018](https://arxiv.org/abs/1801.04381)
- **Anthropic Claude API** for the multi-agent orchestration
- **RunPod** for cost-effective GPU compute
