"use client";

import { useEffect, useState } from "react";

interface PodRow {
  id: string;
  name: string | null;
  desiredStatus: string | null;
  gpuDisplayName: string | null;
  uptimeSeconds: number | null;
  costPerHr: number | null;
  isCurrent: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Notified after a successful terminate so parent can refresh state.  */
  onTerminated?: (terminatedIds: string[]) => void;
}

function formatUptime(seconds: number | null): string {
  if (seconds === null) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function OrphanPodModal({ open, onClose, onTerminated }: Props) {
  const [pods,    setPods]    = useState<PodRow[] | null>(null);
  const [error,   setError]   = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [terminating, setTerminating] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true); setError(null); setSelected(new Set());
    fetch("/api/pipeline/list-pods")
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
        setPods(body.pods ?? []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };

  const handleTerminate = async () => {
    if (selected.size === 0) return;
    if (!confirm(`Terminate ${selected.size} pod(s)? Billing stops immediately.`)) return;
    setTerminating(true); setError(null);
    try {
      const r = await fetch("/api/pipeline/cleanup-orphans", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ podIds: Array.from(selected) }),
      });
      const body = await r.json();
      if (!r.ok) { setError(body.error ?? "Cleanup failed"); return; }
      onTerminated?.(body.terminated ?? []);
      // Re-fetch to refresh the list
      const refresh = await fetch("/api/pipeline/list-pods");
      const refreshBody = await refresh.json();
      setPods(refreshBody.pods ?? []);
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTerminating(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="glass rounded-2xl border border-cyan-500/30 max-w-3xl w-full max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <h2 className="text-lg font-semibold text-cyan-300">Stray RunPod pods</h2>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-slate-300 text-xl leading-none"
            aria-label="Close"
          >×</button>
        </div>

        <div className="overflow-y-auto px-6 py-4 flex-1">
          {loading && <p className="text-slate-400 text-sm">Loading pods from RunPod…</p>}
          {error   && <p className="text-red-400 text-sm">{error}</p>}
          {pods && pods.length === 0 && !loading && (
            <p className="text-slate-400 text-sm">No pods on your RunPod account. ✨</p>
          )}
          {pods && pods.length > 0 && (
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase tracking-widest text-slate-500">
                <tr>
                  <th className="py-2 text-left w-8"></th>
                  <th className="py-2 text-left">Pod</th>
                  <th className="py-2 text-left">GPU</th>
                  <th className="py-2 text-right">Uptime</th>
                  <th className="py-2 text-right">$/hr</th>
                  <th className="py-2 text-right">State</th>
                </tr>
              </thead>
              <tbody>
                {pods.map((p) => (
                  <tr
                    key={p.id}
                    className={`border-t border-slate-800 ${p.isCurrent ? "bg-emerald-500/5" : ""}`}
                  >
                    <td className="py-2">
                      {p.isCurrent ? (
                        <span title="Current run — uncheckable">🟢</span>
                      ) : (
                        <input
                          type="checkbox"
                          checked={selected.has(p.id)}
                          onChange={() => toggle(p.id)}
                        />
                      )}
                    </td>
                    <td className="py-2">
                      <div className="font-mono text-xs text-slate-300">{p.id}</div>
                      <div className="text-xs text-slate-500">{p.name ?? "—"}</div>
                    </td>
                    <td className="py-2 text-xs text-slate-400">{p.gpuDisplayName ?? "—"}</td>
                    <td className="py-2 text-right text-xs text-slate-400">{formatUptime(p.uptimeSeconds)}</td>
                    <td className="py-2 text-right text-xs text-slate-400">
                      {p.costPerHr != null ? `$${p.costPerHr.toFixed(2)}` : "—"}
                    </td>
                    <td className="py-2 text-right text-xs">
                      <span className={p.desiredStatus === "RUNNING" ? "text-emerald-400" : "text-slate-500"}>
                        {p.desiredStatus ?? "—"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex items-center justify-between px-6 py-4 border-t border-slate-800">
          <p className="text-[11px] text-slate-500">
            🟢 = pod tracked by this dashboard (uncheckable)
          </p>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="text-sm px-4 py-2 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800"
            >
              Close
            </button>
            <button
              onClick={handleTerminate}
              disabled={terminating || selected.size === 0}
              className="text-sm px-4 py-2 rounded-lg bg-red-500/15 border border-red-500/40 text-red-300 hover:bg-red-500/25 transition disabled:opacity-50"
            >
              {terminating ? "Terminating…" : `Terminate ${selected.size} selected`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
