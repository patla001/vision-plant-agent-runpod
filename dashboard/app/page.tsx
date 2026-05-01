"use client";

import { useCallback, useEffect, useState } from "react";
import PipelineControl from "@/components/PipelineControl";
import TrainingCurves from "@/components/TrainingCurves";
import MetricsSummary from "@/components/MetricsSummary";
import ConfusionMatrix from "@/components/ConfusionMatrix";

interface PipelineState {
  status: string;
  current_step?: string;
  started_at?: string;
  finished_at?: string;
  logLines?: string[];
  hasResults?: boolean;
  summary?: string;
}

interface ResultsPayload {
  run: string;
  hyperparams: Record<string, unknown> | null;
  splitSummary: Record<string, unknown> | null;
  csvRows: Record<string, string>[];
  pngs: string[];
  classReport: string;
}

export default function DashboardPage() {
  const [pipelineState, setPipelineState] = useState<PipelineState | null>(null);
  const [results, setResults]             = useState<ResultsPayload | null>(null);
  const [loadingResults, setLoadingResults] = useState(false);

  useEffect(() => {
    fetch("/api/pipeline/status")
      .then((r) => r.json())
      .then((data: PipelineState) => {
        setPipelineState(data);
        if (data.status === "done" && data.hasResults) fetchResults();
      });
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  const fetchResults = useCallback(async () => {
    setLoadingResults(true);
    try {
      const res = await fetch("/api/results");
      if (res.ok) setResults(await res.json());
    } finally {
      setLoadingResults(false);
    }
  }, []);

  const handleResultsReady = useCallback(() => {
    fetchResults();
    fetch("/api/pipeline/status").then((r) => r.json()).then(setPipelineState);
  }, [fetchResults]);

  /* ── Initial load ──────────────────────────────────────────── */
  if (!pipelineState) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 rounded-full border-2 border-cyan-500/30 border-t-cyan-400 animate-spin" />
          <p className="text-slate-600 text-sm font-mono">Initializing…</p>
        </div>
      </div>
    );
  }

  /* ── Loading results ───────────────────────────────────────── */
  if (pipelineState.status === "done" && loadingResults) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 rounded-full border-2 border-violet-500/30 border-t-violet-400 animate-spin" />
          <p className="text-slate-400 text-sm animate-pulse">Loading results…</p>
        </div>
      </div>
    );
  }

  /* ── Done but no results were produced (failed agent run, etc.) ──── */
  if (pipelineState.status === "done" && !pipelineState.hasResults) {
    return (
      <div className="space-y-6 animate-float-up">
        <div className="relative overflow-hidden glass rounded-2xl px-5 py-5 border border-amber-500/30">
          <div className="absolute inset-0 bg-gradient-to-r from-amber-500/5 to-transparent pointer-events-none" />
          <div className="flex items-start gap-4">
            <span className="text-2xl">⚠️</span>
            <div className="flex-1">
              <p className="font-bold text-amber-300 text-base">Pipeline marked complete, but no results were produced</p>
              <p className="text-sm text-amber-500/80 mt-1">
                The orchestrator finished without downloading any training artifacts. This usually means
                the training itself failed but the agent decided to stop. Check the agent summary below
                for the post-mortem, then click "Start Over" to try again.
              </p>
            </div>
          </div>
        </div>

        {pipelineState.summary && (
          <section>
            <div className="flex items-center gap-3 mb-4">
              <h2 className="text-lg font-bold gradient-text-cyan-purple">Agent Post-Mortem</h2>
              <span className="text-[10px] px-2 py-0.5 rounded-full border border-violet-500/30 text-violet-400 bg-violet-500/5">
                Claude Opus 4.7
              </span>
            </div>
            <div className="glass rounded-2xl border border-white/5 px-6 py-5 text-sm text-slate-300 whitespace-pre-wrap leading-relaxed font-mono">
              {pipelineState.summary}
            </div>
          </section>
        )}

        <div className="flex gap-3">
          <button
            onClick={async () => {
              await fetch("/api/pipeline/reset", { method: "POST" }).catch(() => {});
              setPipelineState({ status: "idle" });
            }}
            className="px-6 py-2.5 bg-gradient-to-r from-cyan-600 to-violet-600 hover:from-cyan-500 hover:to-violet-500 rounded-xl text-sm font-semibold transition-all shadow-neon-cyan"
          >
            🔄 Start Over
          </button>
        </div>
      </div>
    );
  }

  /* ── Results view ──────────────────────────────────────────── */
  if (pipelineState.status === "done" && results) {
    return (
      <div className="space-y-10 animate-float-up">

        {/* Success banner */}
        <div className="relative overflow-hidden glass rounded-2xl px-6 py-5 border border-emerald-500/25">
          {/* Background glow */}
          <div className="absolute inset-0 bg-gradient-to-r from-emerald-500/8 via-cyan-500/5 to-transparent pointer-events-none" />
          <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-emerald-400/40 to-transparent" />

          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-cyan-600 flex items-center justify-center text-xl shadow-neon-green">
                ✓
              </div>
              <div>
                <p className="font-bold text-emerald-300 text-base">Training complete!</p>
                <p className="text-xs text-emerald-600 mt-0.5">
                  PlantNet-300K · MobileNetV2 · TFLite exported
                </p>
              </div>
            </div>
            <div className="text-right">
              {pipelineState.finished_at && (
                <p className="text-xs text-slate-600">
                  Finished {new Date(pipelineState.finished_at).toLocaleString()}
                </p>
              )}
              <p className="text-[10px] text-slate-700 font-mono mt-0.5">Run: {results.run}</p>
            </div>
          </div>
        </div>

        {/* Results sections */}
        <TrainingCurves csvRows={results.csvRows} />

        <MetricsSummary
          csvRows={results.csvRows}
          hyperparams={results.hyperparams}
          splitSummary={results.splitSummary}
          classReport={results.classReport}
        />

        <ConfusionMatrix run={results.run} pngs={results.pngs} />

        {/* Agent summary */}
        {pipelineState.summary && (
          <section>
            <div className="flex items-center gap-3 mb-4">
              <h2 className="text-lg font-bold gradient-text-cyan-purple">Agent Pipeline Summary</h2>
              <span className="text-[10px] px-2 py-0.5 rounded-full border border-violet-500/30 text-violet-400 bg-violet-500/5">
                Claude Opus 4.7
              </span>
            </div>
            <div className="glass rounded-2xl border border-white/5 px-6 py-5 text-sm text-slate-300 whitespace-pre-wrap leading-relaxed font-mono">
              {pipelineState.summary}
            </div>
          </section>
        )}
      </div>
    );
  }

  /* ── Pipeline control (idle / running / failed) ────────────── */
  return (
    <PipelineControl
      initialState={pipelineState}
      onResultsReady={handleResultsReady}
    />
  );
}
