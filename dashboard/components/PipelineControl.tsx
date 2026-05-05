"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import PipelineSteps from "./PipelineSteps";
import LiveLog from "./LiveLog";
import PodLiveLog from "./PodLiveLog";
import Diagnostics from "./Diagnostics";
import OrphanPodModal from "./OrphanPodModal";

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
  // Pod-side run fields written by laptop_bootstrap.py
  pod_id?: string;
  pod_ip?: string;
  pod_port?: number;
  run_tag?: string;
  screen_session?: string;
  color_correct?: string;
  // Choices the user picked on the home page — persisted by the start route
  // so we can re-hydrate the picker after a failure / pod-terminated event.
  hp_mode?:         "default" | "ai" | "manual";
  hyperparameters?: Record<string, number> | null;
}

interface PollPodResponse {
  inferredStatus: "idle" | "bootstrapping" | "training" | "uploading" | "partial" | "done" | "unknown" | "failed";
  pod: { alive: boolean; desiredStatus: string | null } | null;
  release: { url: string; draft: boolean } | null;
  runTag?: string;
  podId?: string;
  ownerRepo?: { owner: string; repo: string };
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
  // Initialize the home-page pickers from state so a "rerun with same choices"
  // works after the page reloads (server state is the only thing that survives
  // a refresh). "default"/"none" if state has no record.
  const initialColorCorrect: "none" | "gray_world" | "max_rgb" =
    (initialState.color_correct === "gray_world" || initialState.color_correct === "max_rgb")
      ? initialState.color_correct
      : "none";
  const [colorCorrect, setColorCorrect] = useState<"none" | "gray_world" | "max_rgb">(initialColorCorrect);

  // Hyperparameter source on the home page. "default" uses the JSON in the
  // repo. "ai" pulls the latest AI suggestion from /api/results/...; falls
  // back to "default" silently if no suggestion exists. "manual" exposes
  // editable inputs.
  type HpMode = "default" | "ai" | "manual";
  const initialHpMode: HpMode = initialState.hp_mode ?? "default";
  const [hpMode, setHpMode] = useState<HpMode>(initialHpMode);
  const [aiSuggestion, setAiSuggestion] = useState<{
    diagnosis?:   string;
    reasoning?:   string;
    suggested_hyperparameters?: Record<string, number>;
    expected_improvement?: string;
    based_on_run?: string;
    error?:       string;
  } | null>(null);
  const [manualHp, setManualHp] = useState<{
    epochs:                   string;
    learning_rate:            string;
    dropout:                  string;
    early_stopping_patience:  string;
  }>(() => {
    // Re-hydrate from state.hyperparameters when the previous run was started
    // in manual mode. Keeps the user's inputs visible after a page reload so
    // "rerun with same choices" actually works.
    const hp = initialState.hyperparameters ?? {};
    const s = (k: keyof typeof hp): string => hp?.[k] !== undefined ? String(hp[k]) : "";
    return {
      epochs:                   s("epochs"),
      learning_rate:            s("learning_rate"),
      dropout:                  s("dropout"),
      early_stopping_patience:  s("early_stopping_patience"),
    };
  });

  // Lazy-load the AI suggestion when the user picks that mode for the first time.
  // Also re-callable from the manual upload flow so the picker refreshes
  // immediately after a successful POST.
  const fetchAiSuggestion = useCallback(async () => {
    try {
      const r = await fetch("/api/results/suggested-hyperparameters");
      if (r.status === 404) {
        setAiSuggestion({ error: "No prior AI suggestion found — first run will use defaults, or upload one below." });
        return;
      }
      if (!r.ok) {
        setAiSuggestion({ error: `Failed to fetch suggestion (HTTP ${r.status})` });
        return;
      }
      setAiSuggestion(await r.json());
    } catch (e) {
      setAiSuggestion({ error: e instanceof Error ? e.message : String(e) });
    }
  }, []);
  useEffect(() => {
    if (hpMode !== "ai" || aiSuggestion !== null) return;
    void fetchAiSuggestion();
  }, [hpMode, aiSuggestion, fetchAiSuggestion]);

  // Manual-upload form state. Shown inside the "AI suggested" mode so users
  // can plug in a suggestion when the pod-side run failed to ship one (the
  // 2026-05-05 release was missing the suggester JSON despite the run body
  // claiming otherwise — hence this fallback path).
  const [manualUploadOpen, setManualUploadOpen] = useState(false);
  const [manualUploadJson, setManualUploadJson] = useState("");
  const [manualUploadStatus, setManualUploadStatus] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [manualUploadBusy,  setManualUploadBusy ] = useState(false);
  const handleManualUpload = useCallback(async () => {
    setManualUploadBusy(true);
    setManualUploadStatus(null);
    try {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(manualUploadJson);
      } catch (e) {
        setManualUploadStatus({ kind: "err", msg: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` });
        return;
      }
      // Be permissive with the shape: if the user paste just a flat
      // {epochs: 30, ...} object, wrap it under suggested_hyperparameters.
      if (parsed && typeof parsed === "object" && !("suggested_hyperparameters" in parsed)) {
        parsed = { suggested_hyperparameters: parsed };
      }
      const r = await fetch("/api/results/suggested-hyperparameters", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(parsed),
      });
      const data = await r.json();
      if (!r.ok) {
        setManualUploadStatus({ kind: "err", msg: data.error ?? `HTTP ${r.status}` });
        return;
      }
      const accepted = (data.accepted ?? []).join(", ");
      setManualUploadStatus({ kind: "ok", msg: `Saved. Accepted: ${accepted || "none"}` });
      // Refresh the picker so the new suggestion is visible immediately.
      setAiSuggestion(null);
      void fetchAiSuggestion();
    } catch (e) {
      setManualUploadStatus({ kind: "err", msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setManualUploadBusy(false);
    }
  }, [manualUploadJson, fetchAiSuggestion]);

  /** Build the hyperparameters payload for the start request based on the picked mode. */
  const buildHyperparameters = useCallback((): Record<string, number> | null => {
    if (hpMode === "default") return null;
    if (hpMode === "ai") {
      return aiSuggestion?.suggested_hyperparameters ?? null;
    }
    // manual: parse non-empty fields as numbers
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(manualHp)) {
      if (v.trim() === "") continue;
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = n;
    }
    return Object.keys(out).length > 0 ? out : null;
  }, [hpMode, aiSuggestion, manualHp]);

  useEffect(() => {
    if (state.status !== "running") return;
    const id = setInterval(async () => {
      const data: State = await fetch("/api/pipeline/status").then((r) => r.json());
      setState(data);
      if (data.status === "done" && data.hasResults) onResultsReady();
    }, 10_000);
    return () => clearInterval(id);
  }, [state.status, onResultsReady]);

  /* Pod-side run state — polled less aggressively (60s) since each tick
   * makes a RunPod + GitHub API call. Refresh button forces an immediate poll. */
  const [podPoll, setPodPoll] = useState<PollPodResponse | null>(null);
  const [pollRefreshing, setPollRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  const refreshPodPoll = useCallback(async () => {
    setPollRefreshing(true);
    try {
      const r = await fetch("/api/pipeline/poll-pod");
      if (r.ok) setPodPoll(await r.json());
    } finally {
      setPollRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (state.status !== "running-on-pod") return;
    refreshPodPoll();
    const id = setInterval(refreshPodPoll, 60_000);
    return () => clearInterval(id);
  }, [state.status, refreshPodPoll]);

  // Also poll once when entering the failed state so the UI knows whether
  // the pod is still alive — that determines whether "Restart same pod"
  // is offered alongside "Fresh start".
  useEffect(() => {
    if (state.status !== "failed") return;
    if (!state.pod_id) return;   // no pod to check
    refreshPodPoll();
  }, [state.status, state.pod_id, refreshPodPoll]);

  const [orphanModalOpen, setOrphanModalOpen] = useState(false);

  const [restarting, setRestarting] = useState(false);
  const handleRestartTraining = useCallback(async () => {
    if (!confirm("Restart training on the same pod?\n\nThe screen session will be killed, prior results cleared, and training re-run. The pod stays alive and the dataset is reused.")) {
      return;
    }
    setRestarting(true);
    try {
      const r = await fetch("/api/pipeline/restart-training", { method: "POST" });
      const data = await r.json();
      if (!r.ok) {
        alert(`Restart failed: ${data.error ?? "unknown error"}${data.detail ? "\n\n" + data.detail : ""}`);
        return;
      }
      const status: State = await fetch("/api/pipeline/status").then((r) => r.json());
      setState(status);
    } catch (e) {
      alert(`Restart request failed: ${e}`);
    } finally {
      setRestarting(false);
    }
  }, []);

  const [freshStarting, setFreshStarting] = useState(false);
  const handleFreshStart = useCallback(async () => {
    if (!confirm("Fresh start?\n\nThis terminates the current pod (if any), wipes local state, and provisions a new pod. Your color-correction selection is preserved.")) {
      return;
    }
    setFreshStarting(true);
    try {
      // Best-effort abort — fine if there's no pod to terminate.
      try { await fetch("/api/pipeline/abort", { method: "POST" }); } catch { /* ignore */ }
      await fetch("/api/pipeline/reset",  { method: "POST" });
      // Re-call start with the current colorCorrect + hyperparameter selection
      const startRes = await fetch("/api/pipeline/start", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          color_correct:   colorCorrect,
          hyperparameters: buildHyperparameters(),
          hp_mode:         hpMode,
        }),
      });
      const startBody = await startRes.json();
      if (!startRes.ok) {
        alert(`Start failed: ${startBody.error ?? "unknown error"}`);
        return;
      }
      const status: State = await fetch("/api/pipeline/status").then((r) => r.json());
      setState(status);
    } catch (e) {
      alert(`Fresh start failed: ${e}`);
    } finally {
      setFreshStarting(false);
    }
  }, [colorCorrect, buildHyperparameters, hpMode]);

  // Durable record of the most recent run's outcome. Survives /api/pipeline/reset
  // and tells the user, on the idle home page, whether their last run actually
  // produced saved results — closing the gap where pipeline_state.json gets
  // overwritten on every new start, leaving no trace of the prior outcome.
  interface LastRun {
    run_tag:        string;
    outcome:        "completed_synced" | "completed_unsynced" | "partial_upload"
                   | "terminated_no_results" | "aborted_by_user" | "failed_pre_pod";
    finished_at:    string;
    pod_id?:        string;
    color_correct?: string;
    hp_mode?:       string;
    release_url?:   string;
    asset_count?:   number;
    message?:       string;
  }
  const [lastRun, setLastRun] = useState<LastRun | null>(null);
  const refreshLastRun = useCallback(async () => {
    try {
      const r = await fetch("/api/pipeline/last-run");
      if (r.ok) setLastRun(await r.json());
    } catch { /* ignore — non-fatal */ }
  }, []);
  // Pull the last-run record once on mount; also refresh whenever we
  // transition out of an active state into idle so the card stays current.
  useEffect(() => { void refreshLastRun(); }, [refreshLastRun]);
  useEffect(() => {
    if (state.status === "idle") void refreshLastRun();
  }, [state.status, refreshLastRun]);

  // Wipes pipeline_state.json + pipeline.log so the dashboard returns to its
  // idle home page. Used by the "Return to home" button on the pod-terminated
  // banner — when a pod ended without producing a Release, the user wants to
  // get back to a clean slate without spawning a new pod.
  //
  // Before resetting, we POST to /api/pipeline/finalize so the durable
  // last_run.json record captures the outcome (terminated_no_results /
  // partial_upload). That file is what feeds the idle-home "Previous run"
  // card, and reset doesn't touch it — so the user always gets to see
  // whether their last run produced saved results.
  const [resetting, setResetting] = useState(false);
  const handleResetToHome = useCallback(async (
    finalizeOutcome?: "terminated_no_results" | "partial_upload" | "completed_unsynced",
  ) => {
    setResetting(true);
    try {
      if (finalizeOutcome) {
        try {
          await fetch("/api/pipeline/finalize", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ outcome: finalizeOutcome }),
          });
        } catch { /* non-fatal */ }
      }
      // Best-effort abort first so any orphan local Python process / lingering
      // pod is terminated. Server treats both as no-ops if nothing's running.
      try { await fetch("/api/pipeline/abort", { method: "POST" }); } catch { /* ignore */ }
      await fetch("/api/pipeline/reset", { method: "POST" });
      // Force the UI into idle without a full page reload — preserves the
      // hydrated colorCorrect / hpMode / manualHp pickers so the user can
      // tweak settings and click Start without re-entering them.
      setState({ status: "idle" });
      setPodPoll(null);
      // Refresh the last-run card so the idle home page picks up the
      // outcome we just recorded.
      void refreshLastRun();
    } catch (e) {
      alert(`Reset failed: ${e}`);
    } finally {
      setResetting(false);
    }
  }, [refreshLastRun]);

  // When poll-pod reports the run is done, sync local results so the rich
  // results dashboard (TrainingCurves, ConfusionMatrix, etc.) works.
  const handleSyncRelease = useCallback(async () => {
    setSyncing(true);
    setSyncError(null);
    try {
      const r = await fetch("/api/pipeline/sync-release", { method: "POST" });
      const data = await r.json();
      if (!r.ok) { setSyncError(data.error ?? "Sync failed"); return; }
      // After sync, transition local state to "done" so the page shows results.
      setState((prev) => ({ ...prev, status: "done", hasResults: true }));
      onResultsReady();
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  }, [onResultsReady]);

  const handleStart = useCallback(async () => {
    setStarting(true);
    setStartError(null);
    try {
      const hp = buildHyperparameters();
      const res  = await fetch("/api/pipeline/start", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          color_correct:   colorCorrect,
          hyperparameters: hp,
          hp_mode:         hpMode,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setStartError(data.error ?? "Failed to start"); setStarting(false); return; }
      const status: State = await fetch("/api/pipeline/status").then((r) => r.json());
      setState(status);
    } catch {
      setStartError("Network error — is the Next.js dev server running?");
    } finally {
      setStarting(false);
    }
  }, [colorCorrect, buildHyperparameters, hpMode]);

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

  /* ── RUNNING ON POD (detached) ─────────────────────────────── */
  if (state.status === "running-on-pod") {
    const sshCmd = state.pod_ip && state.pod_port
      ? `ssh -p ${state.pod_port} root@${state.pod_ip}`
      : null;
    const inferred = podPoll?.inferredStatus ?? "training";
    const releaseUrl = podPoll?.release?.url;
    const podAlive = podPoll?.pod?.alive ?? null;

    const statusLabel: Record<string, { text: string; color: string }> = {
      bootstrapping: { text: "Bootstrapping (provision in progress)", color: "text-violet-300" },
      training:      { text: "Training on pod",                       color: "text-cyan-300"   },
      uploading:     { text: "Uploading results to GitHub",           color: "text-amber-300"  },
      partial:       { text: "Pod terminated — partial upload",       color: "text-red-300"    },
      done:          { text: "Done — pod terminated",                 color: "text-emerald-300"},
      unknown:       { text: "Pod terminated — no results uploaded",  color: "text-red-300"    },
      failed:        { text: "Failed",                                  color: "text-red-300"    },
    };
    const sl = statusLabel[inferred] ?? { text: inferred, color: "text-slate-300" };

    // Show a prominent pod-terminated banner whenever poll-pod confirms the
    // pod is gone with no usable Release (or a partial one). Without this,
    // the dashboard stays stuck on "Run on pod (detached)" forever even
    // though there's nothing happening on RunPod's side.
    const podTerminated = podAlive === false && (inferred === "unknown" || inferred === "partial");

    return (
      <div className="animate-float-up flex flex-col items-center gap-6 min-h-[60vh] px-4">
        <div className="glass rounded-2xl p-6 w-full max-w-2xl space-y-4 border border-cyan-500/25">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <p className="text-xs uppercase tracking-widest text-slate-500">Run on pod (detached)</p>
              <h2 className={`text-xl font-bold ${sl.color}`}>{sl.text}</h2>
            </div>
            <button
              onClick={refreshPodPoll}
              disabled={pollRefreshing}
              className="text-sm px-4 py-2 rounded-lg border border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 transition disabled:opacity-50"
            >
              {pollRefreshing ? "Refreshing…" : "↻ Refresh status"}
            </button>
          </div>

          {podTerminated && (
            <div className="bg-red-500/10 border border-red-500/40 rounded-xl p-4 space-y-3">
              <div className="flex items-start gap-3">
                <span className="text-2xl">⛔</span>
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-red-300 text-sm">
                    Pod has been terminated
                  </p>
                  <p className="text-xs text-red-300/80 mt-1 leading-relaxed">
                    {inferred === "partial"
                      ? "The orchestrator started uploading results but the pod died before finishing. Some assets may still be downloadable from the draft GitHub Release."
                      : "Training did not finish and no GitHub Release was created — there are no results to download."}
                  </p>
                </div>
              </div>

              {/* Choices we'll re-use if the user clicks "Run again". The pickers below
                  are pre-filled from these so the user can also tweak before re-running. */}
              <div className="text-[11px] text-slate-400 grid grid-cols-2 gap-x-3 gap-y-0.5 bg-slate-900/40 rounded-lg p-2">
                <span className="text-slate-500">Last color correction</span>
                <span className="font-mono">{state.color_correct ?? "default"}</span>
                <span className="text-slate-500">Last hyperparameter mode</span>
                <span className="font-mono">{state.hp_mode ?? "default"}</span>
              </div>

              {/* Hyperparameter picker so the user can choose default / AI-suggested
                  / manual before clicking Run again — fulfills the "this time the user
                  can manually or the AI give the hyperparameters" request. */}
              <div className="space-y-2">
                <p className="text-[10px] uppercase tracking-widest text-slate-500">Hyperparameters for next run</p>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  {(["default", "ai", "manual"] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => setHpMode(m)}
                      className={`px-2 py-1.5 rounded-lg border transition ${
                        hpMode === m
                          ? "border-cyan-400 bg-cyan-500/10 text-cyan-300"
                          : "border-slate-700 text-slate-400 hover:border-slate-500"
                      }`}
                    >
                      {m === "default" ? "Default" : m === "ai" ? "AI suggested" : "Manual"}
                    </button>
                  ))}
                </div>
                {hpMode === "ai" && aiSuggestion?.error && (
                  <p className="text-[11px] text-amber-400">{aiSuggestion.error}</p>
                )}
              </div>

              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  onClick={handleFreshStart}
                  disabled={freshStarting || resetting}
                  className="px-4 py-2 rounded-lg bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/25 transition text-xs font-semibold disabled:opacity-50"
                >
                  {freshStarting ? "Starting…" : "↻ Run again with same color correction"}
                </button>
                <button
                  onClick={() => handleResetToHome(
                    inferred === "partial" ? "partial_upload" : "terminated_no_results",
                  )}
                  disabled={resetting || freshStarting}
                  className="px-4 py-2 rounded-lg border border-slate-600 hover:border-slate-400 text-slate-300 transition text-xs font-semibold disabled:opacity-50"
                >
                  {resetting ? "Resetting…" : "🏠 Return to home"}
                </button>
                <button
                  onClick={() => setOrphanModalOpen(true)}
                  className="px-4 py-2 rounded-lg border border-amber-500/30 hover:border-amber-500/50 text-amber-300 transition text-xs"
                >
                  🔍 Check for stray pods
                </button>
              </div>

              {inferred === "partial" && releaseUrl && (
                <div className="pt-2 border-t border-red-500/20 space-y-2">
                  <a
                    href={releaseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 text-xs text-cyan-300 hover:text-cyan-200"
                  >
                    ⧉ View partial Release on GitHub
                  </a>
                  <button
                    onClick={handleSyncRelease}
                    disabled={syncing}
                    className="w-full px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/40 text-amber-300 hover:bg-amber-500/20 transition text-xs disabled:opacity-50"
                  >
                    {syncing ? "Downloading…" : "⬇ Try to sync partial assets"}
                  </button>
                  {syncError && <p className="text-xs text-red-400">{syncError}</p>}
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="text-slate-500">Pod ID</div>
            <div className="font-mono text-slate-300">{state.pod_id ?? "—"}</div>
            <div className="text-slate-500">Run tag</div>
            <div className="font-mono text-slate-300">{state.run_tag ?? "—"}</div>
            <div className="text-slate-500">Pod state</div>
            <div className="font-mono text-slate-300">
              {podAlive === null ? "—" : (podAlive ? "RUNNING" : (podPoll?.pod?.desiredStatus ?? "GONE"))}
            </div>
            <div className="text-slate-500">Color correction</div>
            <div className="font-mono text-slate-300">{state.color_correct ?? "default"}</div>
          </div>

          {sshCmd && (
            <div className="bg-slate-900/60 border border-slate-700 rounded-lg p-3">
              <p className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">Inspect manually</p>
              <code className="text-xs font-mono text-slate-300 break-all">{sshCmd}</code>
              <p className="text-[10px] text-slate-500 mt-1">
                Then: <code className="font-mono">screen -r cs659</code>
              </p>
            </div>
          )}

          {/* Always-visible live tail of the pod's screen logs. Polls
              /api/pipeline/pod-logs every 10 s while the pod is alive,
              freezes (with last frame still visible) once the pod ends.
              Mirrors the experience of the legacy "running" view, which
              auto-streamed pipeline.log — the user no longer has to click
              "Fetch pod logs" to peek at progress. */}
          {state.pod_ip && state.pod_port && (
            <div className="pt-2 border-t border-slate-800 space-y-2">
              <PodLiveLog enabled={podAlive === true} />
              {podAlive && (
                <div className="flex justify-end">
                  <button
                    onClick={handleAbort}
                    disabled={aborting}
                    className="text-xs px-3 py-1.5 rounded-lg border border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20 transition disabled:opacity-50"
                  >
                    {aborting ? "Aborting…" : "✕ Abort run (terminate pod)"}
                  </button>
                </div>
              )}
            </div>
          )}

          {releaseUrl && (
            <a
              href={releaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-sm text-cyan-300 hover:text-cyan-200"
            >
              ⧉ View GitHub Release
            </a>
          )}

          {inferred === "done" && (
            <div className="space-y-2 pt-2 border-t border-slate-800">
              <button
                onClick={handleSyncRelease}
                disabled={syncing}
                className="w-full px-4 py-3 rounded-lg bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25 transition disabled:opacity-50"
              >
                {syncing ? "Downloading artifacts…" : "⬇ Sync results from Release & open dashboard"}
              </button>
              {syncError && <p className="text-xs text-red-400">{syncError}</p>}
            </div>
          )}

          {!podTerminated && (
            <p className="text-[11px] text-slate-500 leading-relaxed pt-2 border-t border-slate-800">
              The pod runs autonomously — close this tab, shut down your laptop, or come back hours later.
              Results will be uploaded to a GitHub Release before the pod self-terminates.
            </p>
          )}
        </div>
        <OrphanPodModal
          open={orphanModalOpen}
          onClose={() => setOrphanModalOpen(false)}
        />
      </div>
    );
  }

  /* ── IDLE ──────────────────────────────────────────────────── */
  if (state.status === "idle") {
    // Outcome label / styling for the persistent last-run card. Cases the
    // user actually wants to distinguish at a glance: did the run produce
    // saved results, or did the pod die without uploading anything?
    const lastRunMeta: Record<LastRun["outcome"], { icon: string; title: string; tone: string; border: string }> = {
      completed_synced:      { icon: "✅", title: "Completed — results saved",            tone: "text-emerald-300", border: "border-emerald-500/40" },
      completed_unsynced:    { icon: "📦", title: "Completed — Release ready to sync",     tone: "text-cyan-300",    border: "border-cyan-500/40"    },
      partial_upload:        { icon: "⚠️", title: "Partial upload — pod died mid-upload",  tone: "text-amber-300",   border: "border-amber-500/40"   },
      terminated_no_results: { icon: "❌", title: "Pod terminated — no results saved",     tone: "text-red-300",     border: "border-red-500/40"     },
      aborted_by_user:       { icon: "🛑", title: "Aborted by you — no results saved",     tone: "text-red-300",     border: "border-red-500/40"     },
      failed_pre_pod:        { icon: "💥", title: "Failed before pod started",              tone: "text-red-300",     border: "border-red-500/40"     },
    };
    const lr  = lastRun;
    const lrm = lr ? lastRunMeta[lr.outcome] : null;

    return (
      <div className="animate-float-up relative flex flex-col items-center justify-center min-h-[72vh] gap-10 text-center px-4 overflow-hidden">
        {/* Three.js particle neural network — full page background */}
        <HeroScene className="pointer-events-none opacity-60" />

        {/* Previous-run summary card. Tells the user, at a glance, whether the
            last run actually saved results — the gap that motivated the
            run-outcome-tracking skill. Survives /api/pipeline/reset because
            it reads from results/last_run.json, not pipeline_state.json. */}
        {lr && lrm && (
          <div className={`glass rounded-2xl px-5 py-4 w-full max-w-md text-left border ${lrm.border} space-y-3`}>
            <div className="flex items-start gap-3">
              <span className="text-2xl mt-0.5">{lrm.icon}</span>
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-bold ${lrm.tone}`}>{lrm.title}</p>
                <p className="text-[11px] text-slate-500 font-mono break-all">{lr.run_tag}</p>
                <p className="text-[10px] text-slate-600 mt-0.5">
                  {new Date(lr.finished_at).toLocaleString()}
                  {lr.color_correct && lr.color_correct !== "default" && <> · cc: <span className="font-mono">{lr.color_correct}</span></>}
                  {lr.hp_mode && lr.hp_mode !== "default" && <> · hp: <span className="font-mono">{lr.hp_mode}</span></>}
                </p>
                {lr.message && <p className="text-[11px] text-slate-400 mt-1">{lr.message}</p>}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {lr.outcome === "completed_synced" && (
                <a
                  href="/api/results/tflite"
                  className="text-xs px-3 py-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 transition"
                >
                  ⬇ Download .tflite
                </a>
              )}
              {(lr.outcome === "completed_unsynced" || lr.outcome === "partial_upload") && (
                <button
                  onClick={handleSyncRelease}
                  disabled={syncing}
                  className="text-xs px-3 py-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 transition disabled:opacity-50"
                >
                  {syncing ? "Syncing…" : "⬇ Sync release & open dashboard"}
                </button>
              )}
              {lr.release_url && (
                <a
                  href={lr.release_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs px-3 py-1.5 rounded-lg border border-slate-600 hover:border-slate-400 text-slate-300 transition"
                >
                  ⧉ View on GitHub
                </a>
              )}
            </div>
          </div>
        )}

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
            { label: "GITHUB_TOKEN set in .env",               color: "text-fuchsia-400" },
            { label: "SSH public key added to RunPod settings", color: "text-emerald-400" },
          ].map(({ label, color }) => (
            <div key={label} className="flex items-center gap-2.5 text-sm text-slate-400">
              <span className={`${color} text-base`}>›</span>
              {label}
            </div>
          ))}
          <div className="pt-2 border-t border-slate-800 mt-2">
            <button
              onClick={() => setOrphanModalOpen(true)}
              className="text-xs text-amber-400 hover:text-amber-300 transition"
            >
              🔍 Check for stray pods on your RunPod account
            </button>
          </div>
        </div>

        {/* Color correction picker */}
        <div className="glass rounded-2xl p-4 w-full max-w-md text-left space-y-2">
          <label htmlFor="cc-select" className="block text-xs font-semibold text-slate-400 uppercase tracking-widest">
            Color correction
          </label>
          <select
            id="cc-select"
            value={colorCorrect}
            onChange={(e) => setColorCorrect(e.target.value as typeof colorCorrect)}
            disabled={starting}
            className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-cyan-400"
          >
            <option value="none">None — use raw RGB (default)</option>
            <option value="gray_world">Gray-world — assumes neutral scene mean</option>
            <option value="max_rgb">Max-RGB — uses per-channel highlights</option>
          </select>
          <p className="text-[11px] text-slate-500 leading-relaxed">
            Applied to images at training time. Inference must use the same value.
          </p>
        </div>

        {/* Hyperparameter source picker */}
        <div className="glass rounded-2xl p-4 w-full max-w-md text-left space-y-3">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
            Hyperparameters
          </p>
          <div className="grid grid-cols-3 gap-2 text-xs">
            {(["default", "ai", "manual"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setHpMode(m)}
                disabled={starting}
                className={`px-3 py-2 rounded-lg border transition ${
                  hpMode === m
                    ? "border-cyan-400 bg-cyan-500/10 text-cyan-300"
                    : "border-slate-700 text-slate-400 hover:border-slate-500"
                }`}
              >
                {m === "default" ? "Default" : m === "ai" ? "AI suggested" : "Manual"}
              </button>
            ))}
          </div>

          {hpMode === "default" && (
            <p className="text-[11px] text-slate-500 leading-relaxed">
              Use the values committed in <code className="font-mono">model_hyperparameters.json</code>.
              Same as starting without picking anything.
            </p>
          )}

          {hpMode === "ai" && (
            <div className="space-y-2 text-xs">
              {!aiSuggestion && <p className="text-slate-500">Loading suggestion…</p>}
              {aiSuggestion?.error && (
                <p className="text-amber-400">{aiSuggestion.error}</p>
              )}
              {aiSuggestion?.diagnosis && (
                <>
                  <p>
                    <span className="text-slate-500">Diagnosis: </span>
                    <span className={
                      aiSuggestion.diagnosis === "overfitting"  ? "text-amber-300" :
                      aiSuggestion.diagnosis === "underfitting" ? "text-violet-300" :
                                                                 "text-emerald-300"
                    }>{aiSuggestion.diagnosis}</span>
                  </p>
                  {aiSuggestion.reasoning && (
                    <p className="text-slate-400 leading-relaxed">{aiSuggestion.reasoning}</p>
                  )}
                  {aiSuggestion.suggested_hyperparameters && Object.keys(aiSuggestion.suggested_hyperparameters).length > 0 ? (
                    <div className="bg-slate-900/60 border border-slate-700 rounded-lg p-2">
                      <p className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">Suggested changes</p>
                      <ul className="space-y-0.5">
                        {Object.entries(aiSuggestion.suggested_hyperparameters).map(([k, v]) => (
                          <li key={k} className="font-mono text-cyan-300">
                            {k}: <span className="text-slate-200">{String(v)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p className="text-slate-500">Suggester returned no changes — defaults will apply.</p>
                  )}
                  {aiSuggestion.based_on_run && (
                    <p className="text-[10px] text-slate-600 font-mono">based on {aiSuggestion.based_on_run}</p>
                  )}
                </>
              )}

              {/* Manual upload — for when the previous run's Release didn't
                  ship a suggester JSON (a known failure mode we saw on the
                  2026-05-05 run), or when the user wants to override the
                  AI's suggestion with their own values without using the
                  separate Manual mode. */}
              <div className="pt-2 border-t border-slate-800 space-y-1.5">
                <button
                  type="button"
                  onClick={() => setManualUploadOpen((v) => !v)}
                  className="text-[11px] text-slate-400 hover:text-slate-200 transition"
                >
                  {manualUploadOpen ? "▾ Hide manual upload" : "▸ Upload a manual suggestion"}
                </button>
                {manualUploadOpen && (
                  <div className="space-y-1.5">
                    <textarea
                      value={manualUploadJson}
                      onChange={(e) => setManualUploadJson(e.target.value)}
                      placeholder={`{\n  "epochs": 30,\n  "learning_rate": 0.0001,\n  "dropout": 0.4,\n  "early_stopping_patience": 5\n}`}
                      rows={6}
                      className="w-full bg-slate-900/60 border border-slate-700 rounded px-2 py-1.5 text-[11px] font-mono text-slate-200 focus:outline-none focus:border-cyan-400"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleManualUpload}
                        disabled={manualUploadBusy || manualUploadJson.trim() === ""}
                        className="text-[11px] px-2.5 py-1 rounded border border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 transition disabled:opacity-50"
                      >
                        {manualUploadBusy ? "Saving…" : "Save as AI suggestion"}
                      </button>
                      <p className="text-[10px] text-slate-500">
                        Allowed keys: epochs, learning_rate, dropout, early_stopping_patience
                      </p>
                    </div>
                    {manualUploadStatus && (
                      <p className={`text-[11px] ${manualUploadStatus.kind === "ok" ? "text-emerald-300" : "text-red-300"}`}>
                        {manualUploadStatus.msg}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {hpMode === "manual" && (
            <div className="space-y-2">
              <p className="text-[11px] text-slate-500">
                Leave blank to keep the JSON default for that field.
              </p>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {(["epochs", "learning_rate", "dropout", "early_stopping_patience"] as const).map((k) => (
                  <label key={k} className="flex flex-col gap-1">
                    <span className="text-slate-500 font-mono">{k}</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={manualHp[k]}
                      onChange={(e) => setManualHp((p) => ({ ...p, [k]: e.target.value }))}
                      disabled={starting}
                      placeholder={
                        k === "epochs" ? "25" :
                        k === "learning_rate" ? "0.0001" :
                        k === "dropout" ? "0.2" :
                                          "5"
                      }
                      className="bg-slate-900/60 border border-slate-700 rounded px-2 py-1 text-slate-200 focus:outline-none focus:border-cyan-400 font-mono"
                    />
                  </label>
                ))}
              </div>
            </div>
          )}
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
        <OrphanPodModal
          open={orphanModalOpen}
          onClose={() => setOrphanModalOpen(false)}
        />
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

        <div className="flex gap-3 flex-wrap">
          {podPoll?.pod?.alive && (
            <button
              onClick={handleRestartTraining}
              disabled={restarting || freshStarting}
              className="px-6 py-2.5 bg-gradient-to-r from-cyan-600 to-cyan-700 hover:from-cyan-500 hover:to-cyan-600 rounded-xl text-sm font-semibold transition-all shadow-lg disabled:opacity-50"
              title="Skip dataset re-download — reuse the alive pod"
            >
              {restarting ? "Restarting…" : "↻ Restart training (same pod)"}
            </button>
          )}
          <button
            onClick={handleFreshStart}
            disabled={restarting || freshStarting}
            className="px-6 py-2.5 bg-gradient-to-r from-red-600 to-red-700 hover:from-red-500 hover:to-red-600 rounded-xl text-sm font-semibold transition-all shadow-lg disabled:opacity-50"
            title="Terminate current pod, wipe state, provision a new pod"
          >
            {freshStarting ? "Starting…" : "🔄 Fresh start (new pod)"}
          </button>
          <button
            onClick={() => setOrphanModalOpen(true)}
            className="px-5 py-2.5 glass border border-amber-500/30 hover:border-amber-500/50 rounded-xl text-sm font-medium text-amber-300 transition-all"
            title="List every pod on your RunPod account"
          >
            🔍 Check for stray pods
          </button>
          <button
            onClick={() => navigator.clipboard.writeText(state.error_traceback ?? state.current_step ?? "")}
            className="px-5 py-2.5 glass border border-white/10 hover:border-white/20 rounded-xl text-sm font-medium text-slate-300 transition-all"
          >
            📋 Copy error
          </button>
        </div>
        <OrphanPodModal
          open={orphanModalOpen}
          onClose={() => setOrphanModalOpen(false)}
        />
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
