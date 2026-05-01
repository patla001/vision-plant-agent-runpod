"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import PipelineSteps from "./PipelineSteps";
import LiveLog from "./LiveLog";
import Diagnostics from "./Diagnostics";

const HeroScene   = dynamic(() => import("./HeroScene"),   { ssr: false });
const TrainingOrb = dynamic(() => import("./TrainingOrb"), { ssr: false });

// H100 SXM on RunPod is currently ~$2.69/hr on-demand (as of May 2026).
// This is a rough estimate — real billing happens on RunPod's side.
const GPU_HOURLY_RATE = 2.69;

interface Issue {
  type: "error" | "warning";
  lineNumber: number;
  text: string;
  context: string[];
}

interface State {
  status: string;
  current_step?: string;
  started_at?: string;
  finished_at?: string;
  logLines?: string[];
  hasResults?: boolean;
  summary?: string;
  error?: string;
  errors?: Issue[];
  warnings?: Issue[];
  error_type?: string;
  error_message?: string;
  error_traceback?: string;
}

interface Props {
  initialState: State;
  onResultsReady: () => void;
}

function StatBadge({ label, value, color = "cyan" }: { label: string; value: string; color?: "cyan" | "purple" | "green" }) {
  const colors = {
    cyan:   "border-cyan-500/30   bg-cyan-500/5   text-cyan-300",
    purple: "border-violet-500/30 bg-violet-500/5 text-violet-300",
    green:  "border-emerald-500/30 bg-emerald-500/5 text-emerald-300",
  };
  return (
    <div className={`glass rounded-xl p-3 border ${colors[color]} text-center`}>
      <p className="text-[10px] uppercase tracking-widest text-slate-500 mb-0.5">{label}</p>
      <p className="font-semibold text-sm">{value}</p>
    </div>
  );
}

export default function PipelineControl({ initialState, onResultsReady }: Props) {
  const [state, setState]   = useState<State>(initialState);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    if (state.status !== "running") return;
    const id = setInterval(async () => {
      const data: State = await fetch("/api/pipeline/status").then((r) => r.json());
      setState(data);
      if (data.status === "done" && data.hasResults) onResultsReady();
    }, 10_000);
    return () => clearInterval(id);
  }, [state.status, onResultsReady]);

  const handleStart = useCallback(async () => {
    setStarting(true);
    setStartError(null);
    try {
      const res  = await fetch("/api/pipeline/start", { method: "POST" });
      const data = await res.json();
      if (!res.ok) { setStartError(data.error ?? "Failed to start"); setStarting(false); return; }
      const status: State = await fetch("/api/pipeline/status").then((r) => r.json());
      setState(status);
    } catch {
      setStartError("Network error — is the Next.js dev server running?");
    } finally {
      setStarting(false);
    }
  }, []);

  const handleRetry = useCallback(async () => {
    setState({ status: "idle" });
    await handleStart();
  }, [handleStart]);

  const [aborting, setAborting] = useState(false);
  const handleAbort = useCallback(async () => {
    if (!confirm("Abort the running pipeline?\n\nThis will terminate the RunPod pod immediately (stopping billing) and kill the local Python process. Any in-progress training will be lost.")) {
      return;
    }
    setAborting(true);
    try {
      const res  = await fetch("/api/pipeline/abort", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        alert(`Abort failed: ${data.error ?? "unknown error"}`);
      }
      const status: State = await fetch("/api/pipeline/status").then((r) => r.json());
      setState(status);
    } catch (e) {
      alert(`Abort request failed: ${e}`);
    } finally {
      setAborting(false);
    }
  }, []);

  /* ── IDLE ──────────────────────────────────────────────────── */
  if (state.status === "idle") {
    return (
      <div className="animate-float-up relative flex flex-col items-center justify-center min-h-[72vh] gap-10 text-center px-4 overflow-hidden">
        {/* Three.js particle neural network — full page background */}
        <HeroScene className="pointer-events-none opacity-60" />

        {/* Hero */}
        <div className="space-y-4">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-cyan-500/30 bg-cyan-500/5 text-xs text-cyan-400 mb-2">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
            Multi-Agent Pipeline Ready
          </div>
          <h2 className="text-5xl font-bold gradient-text leading-tight">
            Plant Classifier<br />Training
          </h2>
          <p className="text-slate-400 max-w-md text-sm leading-relaxed">
            MobileNetV2 on PlantNet-300K — 306K images, 1081 species.
            Claude Opus 4.7 orchestrates provisioning, training, analysis,
            and pod termination automatically.
          </p>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-3 w-full max-w-sm">
          <StatBadge label="GPU"      value="H100 80GB" color="cyan" />
          <StatBadge label="Est. Time" value="1–2 hrs"  color="purple" />
          <StatBadge label="Est. Cost" value="~$5"      color="green" />
        </div>

        {/* Prerequisites card */}
        <div className="glass rounded-2xl p-5 text-left w-full max-w-md space-y-3">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-2">
            Before starting
          </p>
          {[
            { label: "RUNPOD_API_KEY set in .env",             color: "text-cyan-400" },
            { label: "ANTHROPIC_API_KEY set in .env",          color: "text-violet-400" },
            { label: "SSH public key added to RunPod settings", color: "text-emerald-400" },
          ].map(({ label, color }) => (
            <div key={label} className="flex items-center gap-2.5 text-sm text-slate-400">
              <span className={`${color} text-base`}>›</span>
              {label}
            </div>
          ))}
        </div>

        {startError && (
          <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2">
            {startError}
          </p>
        )}

        {/* CTA button with gradient border */}
        <div className="grad-border">
          <button
            onClick={handleStart}
            disabled={starting}
            className="btn-neon px-10 py-3.5 rounded-xl font-bold text-white text-base tracking-wide"
          >
            {starting ? (
              <span className="flex items-center gap-2">
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
                Launching…
              </span>
            ) : (
              "⚡ Start Training Pipeline"
            )}
          </button>
        </div>
      </div>
    );
  }

  /* ── RUNNING ───────────────────────────────────────────────── */
  if (state.status === "running") {
    const elapsed = state.started_at
      ? Math.round((Date.now() - new Date(state.started_at).getTime()) / 60000)
      : 0;

    return (
      <div className="space-y-6 animate-float-up">

        {/* Three.js orb + status banner side-by-side */}
        <div className="relative overflow-hidden glass rounded-2xl border border-amber-500/25 flex items-center gap-0">
          {/* Orb panel */}
          <div className="flex-shrink-0 w-32 h-32 sm:w-40 sm:h-40 relative">
            <TrainingOrb className="w-full h-full" />
          </div>

        {/* Status banner */}
        <div className="flex-1 px-5 py-4 relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-r from-amber-500/5 via-transparent to-transparent pointer-events-none" />
          <div className="flex items-start gap-4">
            <span className="text-2xl mt-0.5 animate-pulse">⚡</span>
            <div>
              <p className="font-bold text-amber-300 text-base">Pipeline running in the background</p>
              <p className="text-sm text-amber-500/80 mt-0.5">
                Estimated 3–4 hours · You can close this tab and come back later ·
                Progress auto-saves to <code className="text-amber-400 font-mono text-xs">results/pipeline_state.json</code>
              </p>
            </div>
          </div>
        </div>{/* end banner inner */}
        </div>{/* end orb+banner row */}

        {/* Info row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatBadge label="Elapsed"  value={`${elapsed} min`}                                 color="cyan" />
          <StatBadge label="GPU"      value="H100 80GB"                                          color="purple" />
          <StatBadge label="Est. Cost" value={`$${((elapsed / 60) * GPU_HOURLY_RATE).toFixed(2)}`} color="green" />
          <StatBadge label="Status"   value="Running"                                           color="cyan" />
        </div>

        {/* Step progress */}
        <PipelineSteps currentStep={state.current_step ?? ""} status="running" />

        {/* Current step text */}
        {state.current_step && (
          <div className="glass rounded-xl px-4 py-3 border border-white/5 flex items-center gap-3">
            <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse flex-shrink-0" />
            <p className="text-sm text-slate-300">
              <span className="text-slate-500 mr-1">Step:</span>
              {state.current_step}
            </p>
          </div>
        )}

        {/* Diagnostics — error/warning summary with expandable context */}
        <Diagnostics errors={state.errors ?? []} warnings={state.warnings ?? []} />

        {/* Live log */}
        <LiveLog initialLines={state.logLines ?? []} />

        <div className="flex items-center justify-between gap-3 pt-2">
          {state.started_at ? (
            <p className="text-xs text-slate-600">
              Started {new Date(state.started_at).toLocaleString()}
            </p>
          ) : <span />}

          {/* Abort button — terminates pod + kills local process */}
          <button
            onClick={handleAbort}
            disabled={aborting}
            className="px-4 py-2 rounded-lg text-xs font-semibold bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 hover:border-red-500/50 text-red-300 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            title="Terminate pod and kill the local Python process"
          >
            {aborting ? (
              <>
                <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
                Aborting…
              </>
            ) : (
              <>⏹ Abort Pipeline</>
            )}
          </button>
        </div>
      </div>
    );
  }

  /* ── FAILED ────────────────────────────────────────────────── */
  if (state.status === "failed") {
    return (
      <div className="space-y-6 animate-float-up">
        {/* Header banner */}
        <div className="relative overflow-hidden glass rounded-2xl px-5 py-5 border border-red-500/30">
          <div className="absolute inset-0 bg-gradient-to-r from-red-500/5 to-transparent pointer-events-none" />
          <div className="flex items-start gap-4">
            <span className="text-2xl">💥</span>
            <div className="flex-1 min-w-0">
              <p className="font-bold text-red-300 text-base">Pipeline failed</p>
              {state.error_type ? (
                <p className="text-sm mt-1">
                  <span className="font-mono text-red-400 font-semibold">{state.error_type}</span>
                  <span className="text-red-400/80">: {state.error_message}</span>
                </p>
              ) : (
                <p className="text-sm text-red-400/80 mt-1">{state.current_step}</p>
              )}
            </div>
          </div>
        </div>

        {/* Diagnostics — error/warning summary */}
        <Diagnostics errors={state.errors ?? []} warnings={state.warnings ?? []} />

        {/* Python traceback (if captured) */}
        {state.error_traceback && (
          <div className="terminal">
            <div className="terminal-bar px-4 py-2.5 flex items-center gap-2">
              <div className="flex gap-1.5">
                <span className="w-3 h-3 rounded-full bg-red-500" />
                <span className="w-3 h-3 rounded-full bg-amber-500/50" />
                <span className="w-3 h-3 rounded-full bg-green-500/50" />
              </div>
              <span className="text-xs text-slate-500 font-mono ml-2">python traceback</span>
            </div>
            <pre className="p-4 font-mono text-[11px] text-red-300/90 max-h-80 overflow-auto whitespace-pre leading-relaxed">
              {state.error_traceback}
            </pre>
          </div>
        )}

        {/* Last log lines (always show as fallback) */}
        <div className="terminal">
          <div className="terminal-bar px-4 py-2.5 flex items-center gap-2">
            <div className="flex gap-1.5">
              <span className="w-3 h-3 rounded-full bg-red-500" />
              <span className="w-3 h-3 rounded-full bg-amber-500/50" />
              <span className="w-3 h-3 rounded-full bg-green-500/50" />
            </div>
            <span className="text-xs text-slate-500 font-mono ml-2">last 50 lines · pipeline.log</span>
          </div>
          <div className="p-4 font-mono text-xs max-h-64 overflow-y-auto space-y-0.5">
            {(state.logLines ?? []).slice(-50).map((l, i) => {
              const isError = /\b(ERROR|Error|Traceback|Exception|FAILED|failed)\b/.test(l);
              const isWarn  = !isError && /\b(WARN|WARNING|Warning|warning)\b/.test(l);
              const c = isError ? "text-red-400" : isWarn ? "text-amber-400" : "text-slate-400";
              return <div key={i} className={`${c} whitespace-pre-wrap break-all`}>{l}</div>;
            })}
          </div>
        </div>

        <div className="flex gap-3">
          <button
            onClick={handleRetry}
            className="px-6 py-2.5 bg-gradient-to-r from-red-600 to-red-700 hover:from-red-500 hover:to-red-600 rounded-xl text-sm font-semibold transition-all shadow-lg"
          >
            🔄 Retry Pipeline
          </button>
          <button
            onClick={() => navigator.clipboard.writeText(state.error_traceback ?? state.current_step ?? "")}
            className="px-5 py-2.5 glass border border-white/10 hover:border-white/20 rounded-xl text-sm font-medium text-slate-300 transition-all"
          >
            📋 Copy error
          </button>
        </div>
      </div>
    );
  }

  /* ── DONE fallback ─────────────────────────────────────────── */
  return (
    <div className="glass rounded-2xl px-5 py-4 border border-emerald-500/30 flex items-center gap-3">
      <span className="text-xl">✅</span>
      <p className="font-semibold text-emerald-300">Training complete — loading results…</p>
    </div>
  );
}
