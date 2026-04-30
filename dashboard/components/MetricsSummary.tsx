"use client";

type Row = Record<string, string>;

interface Props {
  csvRows: Row[];
  hyperparams: Record<string, unknown> | null;
  splitSummary: Record<string, unknown> | null;
  classReport: string;
}

const METRIC_COLS = [
  { key: "accuracy",        label: "Accuracy",  color: "cyan" },
  { key: "f1_macro",        label: "F1 Macro",  color: "purple" },
  { key: "f1_weighted",     label: "F1 Wt.",    color: "purple" },
  { key: "precision_macro", label: "Precision", color: "green" },
  { key: "recall_macro",    label: "Recall",    color: "green" },
  { key: "roc_auc_macro",   label: "ROC AUC",   color: "amber" },
] as const;

type MetricColor = "cyan" | "purple" | "green" | "amber";

const SPLITS = ["train", "val", "test"] as const;

const SPLIT_STYLE: Record<string, { dot: string; label: string }> = {
  train: { dot: "bg-cyan-500",    label: "text-cyan-300" },
  val:   { dot: "bg-violet-500",  label: "text-violet-300" },
  test:  { dot: "bg-emerald-500", label: "text-emerald-300" },
};

const COLOR_MAP: Record<MetricColor, string> = {
  cyan:   "text-cyan-400",
  purple: "text-violet-400",
  green:  "text-emerald-400",
  amber:  "text-amber-400",
};

function lastRow(rows: Row[], split: string): Row | undefined {
  return [...rows].reverse().find((r) => Object.keys(r).some((k) => k.startsWith(`${split}_`)));
}

function fmt(v: string | undefined): string {
  if (!v || isNaN(Number(v))) return "—";
  return (Number(v) * 100).toFixed(1) + "%";
}

function pct(v: string | undefined): number {
  if (!v || isNaN(Number(v))) return 0;
  return Number(v) * 100;
}

function BigMetricCard({ label, value, color }: { label: string; value: string; color: MetricColor }) {
  const c = COLOR_MAP[color];
  return (
    <div className={`glass rounded-xl p-4 border metric-card-${color} text-center`}>
      <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-1">{label}</p>
      <p className={`text-2xl font-bold font-mono ${c}`}>{value}</p>
    </div>
  );
}

export default function MetricsSummary({ csvRows, hyperparams, splitSummary, classReport }: Props) {
  const dl = (hyperparams as Record<string, Record<string, unknown>> | null)?.deep_learning ?? {};
  const testRow = lastRow(csvRows, "test");

  return (
    <section className="space-y-8">

      {/* Big test-set highlight cards */}
      {testRow && (
        <div>
          <div className="flex items-center gap-3 mb-4">
            <h2 className="text-lg font-bold gradient-text-cyan-purple">Test Set Results</h2>
            <span className="text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full">Final</span>
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
            {METRIC_COLS.map((col) => (
              <BigMetricCard
                key={col.key}
                label={col.label}
                value={fmt(testRow[`test_${col.key}`])}
                color={col.color}
              />
            ))}
          </div>
        </div>
      )}

      {/* Full metrics table */}
      <div>
        <h2 className="text-lg font-bold gradient-text-cyan-purple mb-4">All Splits</h2>
        <div className="glass rounded-2xl border border-white/5 overflow-hidden">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-white/5">
                <th className="px-5 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-widest">Split</th>
                {METRIC_COLS.map((c) => (
                  <th key={c.key} className={`px-4 py-3 text-right text-xs font-semibold uppercase tracking-widest ${COLOR_MAP[c.color]}`}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SPLITS.map((split, i) => {
                const row = lastRow(csvRows, split);
                const style = SPLIT_STYLE[split];
                return (
                  <tr key={split} className={`border-b border-white/3 hover:bg-white/2 transition-colors ${i === SPLITS.length - 1 ? "border-0" : ""}`}>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${style.dot}`} />
                        <span className={`capitalize font-semibold text-sm ${style.label}`}>{split}</span>
                      </div>
                    </td>
                    {METRIC_COLS.map((c) => {
                      const val = row?.[`${split}_${c.key}`];
                      const num = pct(val);
                      return (
                        <td key={c.key} className="px-4 py-3 text-right tabular-nums">
                          <span className={`font-mono text-sm ${num > 70 ? COLOR_MAP[c.color] : num > 40 ? "text-amber-400" : "text-slate-400"}`}>
                            {fmt(val)}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Dataset split sizes */}
      {splitSummary && (
        <div>
          <h2 className="text-lg font-bold gradient-text-cyan-purple mb-4">Dataset</h2>
          <div className="grid grid-cols-3 gap-4">
            {SPLITS.map((s) => {
              const ss = splitSummary as Record<string, Record<string, number>>;
              const n  = ss[s]?.n_images ?? ss[s]?.n ?? "—";
              const style = SPLIT_STYLE[s];
              return (
                <div key={s} className={`glass rounded-xl p-5 border metric-card-${s === "train" ? "cyan" : s === "val" ? "purple" : "green"} text-center`}>
                  <div className={`flex items-center justify-center gap-1.5 text-[10px] uppercase tracking-widest mb-2 ${style.label}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
                    {s}
                  </div>
                  <p className="text-3xl font-bold font-mono text-slate-100">
                    {typeof n === "number" ? n.toLocaleString() : n}
                  </p>
                  <p className="text-[10px] text-slate-600 mt-1">images</p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Hyperparameters */}
      {Object.keys(dl).length > 0 && (
        <div>
          <h2 className="text-lg font-bold gradient-text-cyan-purple mb-4">Hyperparameters</h2>
          <div className="glass rounded-2xl border border-white/5 px-5 py-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
            {Object.entries(dl).map(([k, v]) => (
              <div key={k} className="group">
                <p className="text-[10px] text-slate-600 uppercase tracking-wider mb-0.5 group-hover:text-slate-500 transition-colors">
                  {k.replace(/_/g, " ")}
                </p>
                <p className="text-sm font-mono text-cyan-300">{String(v)}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Classification report */}
      {classReport && (
        <div>
          <h2 className="text-lg font-bold gradient-text-cyan-purple mb-4">Classification Report</h2>
          <div className="terminal">
            <div className="terminal-bar px-4 py-2.5 flex items-center gap-2">
              <div className="flex gap-1.5">
                <span className="w-3 h-3 rounded-full bg-red-500/70" />
                <span className="w-3 h-3 rounded-full bg-amber-500/70" />
                <span className="w-3 h-3 rounded-full bg-green-500/70" />
              </div>
              <span className="text-xs text-slate-500 font-mono ml-1">test_classification_report.txt</span>
            </div>
            <pre className="p-5 text-xs text-cyan-200/70 overflow-x-auto whitespace-pre font-mono leading-relaxed">
              {classReport}
            </pre>
          </div>
        </div>
      )}
    </section>
  );
}
