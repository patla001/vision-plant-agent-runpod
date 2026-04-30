"use client";

import { useEffect, useRef, useState } from "react";

interface Props { initialLines: string[] }

export default function LiveLog({ initialLines }: Props) {
  const [lines, setLines] = useState<string[]>(initialLines);
  const bottomRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  return (
    <div className="terminal">
      {/* macOS-style title bar */}
      <div className="terminal-bar px-4 py-2.5 flex items-center gap-3">
        <div className="flex gap-1.5">
          <span className="w-3 h-3 rounded-full bg-red-500/80 hover:bg-red-400 cursor-pointer transition-colors" />
          <span className="w-3 h-3 rounded-full bg-amber-500/80 hover:bg-amber-400 cursor-pointer transition-colors" />
          <span className="w-3 h-3 rounded-full bg-green-500/80 hover:bg-green-400 cursor-pointer transition-colors" />
        </div>
        <div className="flex-1 text-center">
          <span className="text-[11px] text-slate-500 font-mono">pipeline.log</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
          <span className="text-[10px] text-cyan-500 font-mono uppercase tracking-wider">live</span>
        </div>
      </div>

      {/* Log content */}
      <div className="h-80 overflow-y-auto p-4 font-mono text-xs leading-5 space-y-0.5 relative">
        {/* Subtle scan line */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden opacity-20">
          <div className="absolute w-full h-1 bg-cyan-400/20 animate-scan-line" />
        </div>

        {lines.length === 0 ? (
          <p className="text-slate-600 italic">Waiting for output…</p>
        ) : (
          lines.map((line, i) => {
            // Color-code log levels
            const color = line.includes("ERROR") || line.includes("error")
              ? "text-red-400"
              : line.includes("WARN")
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

        {/* Blinking cursor */}
        <div className="inline-flex items-center gap-0.5 mt-0.5">
          <span className="text-cyan-400 font-mono">$</span>
          <span className="w-2 h-3.5 bg-cyan-400 animate-blink-cursor rounded-sm ml-1" />
        </div>

        <div ref={bottomRef} />
      </div>
    </div>
  );
}
