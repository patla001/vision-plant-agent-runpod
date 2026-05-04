"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface PodLogsData {
  podIp?:           string;
  podPort?:         number;
  screenSessions:   string;
  setupLog:         string;
  orchestratorLog:  string;
  trainingLogTail:  string;
}

type Tab = "setup" | "orchestrator" | "training" | "screen";

interface Props {
  /** When false, polling is suspended (e.g. pod is terminated). The panel
   *  stays visible with whatever was last fetched so the user can still
   *  read the final log lines. */
  enabled:    boolean;
  intervalMs?: number;
}

const ERROR_RE   = /\b(ERROR|Error|Traceback|Exception|FAILED|failed)\b/;
const WARNING_RE = /\b(WARN|WARNING|Warning|warning)\b/;

function colorize(line: string): string {
  if (ERROR_RE.test(line))   return "text-red-400";
  if (WARNING_RE.test(line)) return "text-amber-400";
  if (line.includes("DONE") || line.includes("complete") || line.includes("success")) {
    return "text-emerald-400";
  }
  return "text-cyan-300/80";
}

/**
 * Live tail of the pod's screen logs. Polls /api/pipeline/pod-logs on a
 * timer and renders the last ~120 lines of setup.log / orchestrator.log /
 * training.log / `screen -ls` in a terminal-styled tabbed panel.
 *
 * Why polling instead of SSE: pod-logs SSHes to the pod for each tail, so
 * a long-lived stream would mean keeping a `tail -f` SSH connection open
 * indefinitely — more moving parts than a single-user dev tool needs. A
 * 10 s tick is "live enough" for watching training progress while keeping
 * the SSH overhead bounded.
 */
export default function PodLiveLog({ enabled, intervalMs = 10_000 }: Props) {
  const [data,     setData]     = useState<PodLogsData | null>(null);
  const [tab,      setTab]      = useState<Tab>("setup");
  const [paused,   setPaused]   = useState(false);
  const [fetching, setFetching] = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [lastAt,   setLastAt]   = useState<Date | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);

  const fetchOnce = useCallback(async () => {
    setFetching(true);
    setError(null);
    try {
      const r = await fetch("/api/pipeline/pod-logs");
      const body = await r.json();
      if (!r.ok) {
        setError(body.error ?? `HTTP ${r.status}`);
      } else {
        setData(body);
        setLastAt(new Date());
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFetching(false);
    }
  }, []);

  // Auto-poll on the requested interval. Refetches immediately whenever
  // the polling state flips on (enabled true, paused off) so the user
  // doesn't wait a full tick for the first frame.
  useEffect(() => {
    if (!enabled || paused) return;
    void fetchOnce();
    const id = setInterval(() => { void fetchOnce(); }, intervalMs);
    return () => clearInterval(id);
  }, [enabled, paused, intervalMs, fetchOnce]);

  const activeContent = useMemo(() => {
    if (!data) return "";
    switch (tab) {
      case "setup":         return data.setupLog;
      case "orchestrator":  return data.orchestratorLog;
      case "training":      return data.trainingLogTail;
      case "screen":        return data.screenSessions;
    }
  }, [data, tab]);

  const lines = useMemo(
    () => activeContent ? activeContent.split("\n").filter((l) => l.length > 0) : [],
    [activeContent],
  );

  // Auto-scroll to bottom when new content arrives — mirrors LiveLog.tsx.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  const status = !enabled
    ? { dot: "bg-slate-500",   text: "stopped",   tone: "text-slate-500" }
    : paused
    ? { dot: "bg-amber-400",   text: "paused",    tone: "text-amber-400" }
    : fetching
    ? { dot: "bg-cyan-400 animate-pulse", text: "fetching", tone: "text-cyan-400" }
    : { dot: "bg-emerald-400 animate-pulse", text: "live",  tone: "text-emerald-400" };

  return (
    <div className="terminal">
      {/* Title bar */}
      <div className="terminal-bar px-4 py-2.5 flex items-center gap-3 flex-wrap">
        <div className="flex gap-1.5">
          <span className="w-3 h-3 rounded-full bg-red-500/80" />
          <span className="w-3 h-3 rounded-full bg-amber-500/80" />
          <span className="w-3 h-3 rounded-full bg-green-500/80" />
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 ml-2">
          <TabPill active={tab === "setup"}        onClick={() => setTab("setup")}        label="setup.log" />
          <TabPill active={tab === "orchestrator"} onClick={() => setTab("orchestrator")} label="orchestrator.log" />
          <TabPill active={tab === "training"}     onClick={() => setTab("training")}     label="training.log" />
          <TabPill active={tab === "screen"}       onClick={() => setTab("screen")}       label="screen -ls" />
        </div>

        <div className="flex-1" />

        {/* Controls + live indicator */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => void fetchOnce()}
            disabled={fetching || !enabled}
            className="text-[10px] px-2 py-0.5 rounded-full border border-slate-700 hover:border-slate-500 text-slate-400 hover:text-slate-200 transition disabled:opacity-40"
            title="Refresh now"
          >
            ↻
          </button>
          <button
            onClick={() => setPaused((p) => !p)}
            disabled={!enabled}
            className="text-[10px] px-2 py-0.5 rounded-full border border-slate-700 hover:border-slate-500 text-slate-400 hover:text-slate-200 transition disabled:opacity-40"
            title={paused ? "Resume auto-refresh" : "Pause auto-refresh"}
          >
            {paused ? "▶" : "❚❚"}
          </button>
          <span className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
            <span className={`text-[10px] font-mono uppercase tracking-wider ${status.tone}`}>{status.text}</span>
          </span>
        </div>
      </div>

      {/* Log content */}
      <div className="h-80 overflow-y-auto p-4 font-mono text-xs leading-5 space-y-0.5 relative">
        <div className="pointer-events-none absolute inset-0 overflow-hidden opacity-20">
          <div className="absolute w-full h-1 bg-cyan-400/20 animate-scan-line" />
        </div>

        {error && (
          <p className="text-red-400 italic">SSH error: {error}</p>
        )}

        {!error && lines.length === 0 && (
          <p className="text-slate-600 italic">
            {data ? "(empty — waiting for output…)" : "Connecting to pod…"}
          </p>
        )}

        {lines.map((line, i) => (
          <div
            key={i}
            className={`${colorize(line)} whitespace-pre-wrap break-all hover:bg-white/3 rounded px-1 -mx-1 transition-colors`}
          >
            {line}
          </div>
        ))}

        {/* Blinking-cursor flourish, same as LiveLog */}
        <div className="inline-flex items-center gap-0.5 mt-0.5">
          <span className="text-cyan-400 font-mono">$</span>
          <span className="w-2 h-3.5 bg-cyan-400 animate-blink-cursor rounded-sm ml-1" />
        </div>

        <div ref={bottomRef} />
      </div>

      {/* Footer with last-fetched timestamp + pod address */}
      <div className="px-4 py-1.5 border-t border-slate-800 flex items-center justify-between text-[10px] text-slate-600 font-mono">
        <span>
          {data?.podIp && data?.podPort ? `root@${data.podIp}:${data.podPort}` : "—"}
        </span>
        <span>
          {lastAt ? `updated ${lastAt.toLocaleTimeString()}` : ""}
        </span>
      </div>
    </div>
  );
}

function TabPill({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`text-[10px] px-2 py-0.5 rounded-full border font-medium transition-all ${
        active
          ? "bg-cyan-500/20 border-cyan-500/40 text-cyan-300"
          : "border-transparent text-slate-500 hover:text-slate-300"
      }`}
    >
      {label}
    </button>
  );
}
