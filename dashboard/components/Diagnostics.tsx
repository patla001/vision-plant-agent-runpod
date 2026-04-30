"use client";

import { useState } from "react";

interface Issue {
  type: "error" | "warning";
  lineNumber: number;
  text: string;
  context: string[];
}

interface Props {
  errors:   Issue[];
  warnings: Issue[];
}

export default function Diagnostics({ errors, warnings }: Props) {
  const [open, setOpen]   = useState(true);
  const [tab, setTab]     = useState<"errors" | "warnings">(errors.length ? "errors" : "warnings");

  const issues = tab === "errors" ? errors : warnings;
  const hasAny = errors.length > 0 || warnings.length > 0;

  return (
    <div className="glass rounded-2xl border border-white/5 overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-5 py-3 flex items-center justify-between hover:bg-white/3 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-slate-200">Diagnostics</span>
          {hasAny ? (
            <div className="flex items-center gap-2">
              {errors.length > 0 && (
                <span className="text-xs px-2 py-0.5 rounded-full border border-red-500/40 bg-red-500/10 text-red-300 font-medium">
                  {errors.length} {errors.length === 1 ? "error" : "errors"}
                </span>
              )}
              {warnings.length > 0 && (
                <span className="text-xs px-2 py-0.5 rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-300 font-medium">
                  {warnings.length} {warnings.length === 1 ? "warning" : "warnings"}
                </span>
              )}
            </div>
          ) : (
            <span className="text-xs px-2 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/5 text-emerald-400">
              ✓ No issues
            </span>
          )}
        </div>
        <span className={`text-slate-500 transition-transform ${open ? "rotate-90" : ""}`}>›</span>
      </button>

      {open && hasAny && (
        <div className="border-t border-white/5">
          {/* Tab pills */}
          <div className="flex gap-2 px-5 pt-3 pb-1">
            <TabPill
              active={tab === "errors"}
              onClick={() => setTab("errors")}
              count={errors.length}
              label="Errors"
              colorClass="red"
            />
            <TabPill
              active={tab === "warnings"}
              onClick={() => setTab("warnings")}
              count={warnings.length}
              label="Warnings"
              colorClass="amber"
            />
          </div>

          {/* Issue list */}
          <div className="px-2 pb-3 space-y-1 max-h-72 overflow-y-auto">
            {issues.length === 0 ? (
              <p className="text-xs text-slate-600 italic px-3 py-4">No {tab} found.</p>
            ) : (
              issues.map((iss, i) => <IssueRow key={`${iss.lineNumber}-${i}`} issue={iss} />)
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TabPill({
  active, onClick, count, label, colorClass,
}: {
  active: boolean; onClick: () => void; count: number; label: string; colorClass: "red" | "amber";
}) {
  const colors = colorClass === "red"
    ? { active: "border-red-500/50   bg-red-500/15   text-red-300",   inactive: "border-white/5 text-slate-500" }
    : { active: "border-amber-500/50 bg-amber-500/15 text-amber-300", inactive: "border-white/5 text-slate-500" };

  return (
    <button
      onClick={onClick}
      className={`text-xs px-3 py-1 rounded-full border font-medium transition-all ${active ? colors.active : colors.inactive}`}
    >
      {label} <span className="opacity-60">({count})</span>
    </button>
  );
}

function IssueRow({ issue }: { issue: Issue }) {
  const [expanded, setExpanded] = useState(false);
  const isError = issue.type === "error";
  const dotColor = isError ? "bg-red-400" : "bg-amber-400";
  const textColor = isError ? "text-red-200" : "text-amber-200";

  return (
    <div className={`rounded-lg px-3 py-2 hover:bg-white/3 cursor-pointer transition-colors ${isError ? "border-l-2 border-red-500/40" : "border-l-2 border-amber-500/40"} ml-2`}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-start gap-2">
        <span className={`w-1.5 h-1.5 rounded-full ${dotColor} mt-1.5 flex-shrink-0`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-[10px] text-slate-600 font-mono">L{issue.lineNumber}</span>
            <span className={`text-xs font-mono ${textColor} break-all`}>{issue.text}</span>
          </div>
          {expanded && issue.context.length > 0 && (
            <div className="mt-2 ml-4 pl-3 border-l border-white/10 space-y-0.5">
              {issue.context.map((c, i) => (
                <div key={i} className="text-[11px] font-mono text-slate-500 break-all">
                  {c}
                </div>
              ))}
            </div>
          )}
        </div>
        {issue.context.length > 0 && (
          <span className={`text-slate-600 text-xs transition-transform ${expanded ? "rotate-90" : ""}`}>›</span>
        )}
      </div>
    </div>
  );
}
