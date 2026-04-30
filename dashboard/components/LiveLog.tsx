"use client";

import { useEffect, useMemo, useRef, useState } from "react";

interface Props { initialLines: string[] }
type Filter = "all" | "errors" | "warnings";

const ERROR_RE       = /\b(ERROR|Error|Traceback|Exception|FAILED|failed)\b/;
const WARNING_RE     = /\b(WARN|WARNING|Warning|warning)\b/;
const FILTER_STORAGE_KEY = "liveLog.filter";

function readStoredFilter(): Filter {
  if (typeof window === "undefined") return "all";
  const v = window.localStorage.getItem(FILTER_STORAGE_KEY);
  return v === "errors" || v === "warnings" ? v : "all";
}

export default function LiveLog({ initialLines }: Props) {
  const [lines, setLines]   = useState<string[]>(initialLines);
  const [filter, setFilter] = useState<Filter>(readStoredFilter);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Persist filter choice across page reloads
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(FILTER_STORAGE_KEY, filter);
    }
  }, [filter]);

  useEffect(() => {
    const es = new EventSource("/api/pipeline/logs");
    es.onmessage = (e) => {
      try {
        const newLines: string[] = JSON.parse(e.data);
        if (newLines.length) setLines((prev) => [...prev, ...newLines].slice(-500));
      } catch { /* ignore */ }
    };
    return () => es.close();
  }, []);

  const visible = useMemo(() => {
    if (filter === "all") return lines;
    if (filter === "errors")   return lines.filter((l) => ERROR_RE.test(l));
    if (filter === "warnings") return lines.filter((l) => WARNING_RE.test(l) && !ERROR_RE.test(l));
    return lines;
  }, [lines, filter]);

  useEffect(() => {
    if (filter === "all") bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [visible, filter]);

  const errorCount   = useMemo(() => lines.filter((l) => ERROR_RE.test(l)).length, [lines]);
  const warningCount = useMemo(() => lines.filter((l) => WARNING_RE.test(l) && !ERROR_RE.test(l)).length, [lines]);

  return (
    <div className="terminal">
      {/* macOS-style title bar with filter pills */}
      <div className="terminal-bar px-4 py-2.5 flex items-center gap-3">
        <div className="flex gap-1.5">
          <span className="w-3 h-3 rounded-full bg-red-500/80" />
          <span className="w-3 h-3 rounded-full bg-amber-500/80" />
          <span className="w-3 h-3 rounded-full bg-green-500/80" />
        </div>

        {/* Filter pills */}
        <div className="flex items-center gap-1 ml-2">
          <FilterPill active={filter === "all"}      onClick={() => setFilter("all")}      label="All"      count={lines.length} />
          <FilterPill active={filter === "errors"}   onClick={() => setFilter("errors")}   label="Errors"   count={errorCount}   color="red" />
          <FilterPill active={filter === "warnings"} onClick={() => setFilter("warnings")} label="Warnings" count={warningCount} color="amber" />
        </div>

        <div className="flex-1" />
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
          <span className="text-[10px] text-cyan-500 font-mono uppercase tracking-wider">live</span>
        </div>
      </div>

      {/* Log content */}
      <div className="h-80 overflow-y-auto p-4 font-mono text-xs leading-5 space-y-0.5 relative">
        <div className="pointer-events-none absolute inset-0 overflow-hidden opacity-20">
          <div className="absolute w-full h-1 bg-cyan-400/20 animate-scan-line" />
        </div>

        {visible.length === 0 ? (
          <p className="text-slate-600 italic">
            {filter === "all" ? "Waiting for output…" : `No ${filter} found.`}
          </p>
        ) : (
          visible.map((line, i) => {
            const color = ERROR_RE.test(line)
              ? "text-red-400"
              : WARNING_RE.test(line)
              ? "text-amber-400"
              : line.includes("DONE") || line.includes("complete") || line.includes("success")
              ? "text-emerald-400"
              : "text-cyan-300/80";

            return (
              <div key={i} className={`${color} whitespace-pre-wrap break-all hover:bg-white/3 rounded px-1 -mx-1 transition-colors`}>
                {line}
              </div>
            );
          })
        )}

        <div className="inline-flex items-center gap-0.5 mt-0.5">
          <span className="text-cyan-400 font-mono">$</span>
          <span className="w-2 h-3.5 bg-cyan-400 animate-blink-cursor rounded-sm ml-1" />
        </div>

        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function FilterPill({
  active, onClick, label, count, color = "cyan",
}: {
  active: boolean; onClick: () => void; label: string; count: number; color?: "cyan" | "red" | "amber";
}) {
  const colors = {
    cyan:  active ? "bg-cyan-500/20 border-cyan-500/40 text-cyan-300"   : "border-transparent text-slate-500 hover:text-slate-300",
    red:   active ? "bg-red-500/20 border-red-500/40 text-red-300"     : "border-transparent text-slate-500 hover:text-slate-300",
    amber: active ? "bg-amber-500/20 border-amber-500/40 text-amber-300" : "border-transparent text-slate-500 hover:text-slate-300",
  };
  return (
    <button onClick={onClick}
      className={`text-[10px] px-2 py-0.5 rounded-full border font-medium transition-all ${colors[color]}`}
    >
      {label} <span className="opacity-60">{count}</span>
    </button>
  );
}
