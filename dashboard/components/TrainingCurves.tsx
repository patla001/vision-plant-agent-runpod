"use client";

import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, Area, AreaChart,
} from "recharts";

type Row = Record<string, string>;
interface Props { csvRows: Row[] }

const CHART_BG   = "#050d14";
const GRID_COLOR = "rgba(255,255,255,0.05)";

export default function TrainingCurves({ csvRows }: Props) {
  if (!csvRows.length) return (
    <p className="text-slate-600 text-sm italic">No CSV data found yet.</p>
  );

  const data = csvRows.map((r) => ({
    epoch:     Number(r.epoch ?? r.Epoch ?? 0) + 1,
    train_acc: Number(r.train_accuracy  ?? r.train_acc ?? 0),
    val_acc:   Number(r.val_accuracy    ?? r.val_acc   ?? 0),
    train_f1:  Number(r.train_f1_macro  ?? r.train_f1  ?? 0),
    val_f1:    Number(r.val_f1_macro    ?? r.val_f1    ?? 0),
  }));

  return (
    <section>
      <div className="flex items-center gap-3 mb-5">
        <h2 className="text-lg font-bold gradient-text-cyan-purple">Training Curves</h2>
        <span className="text-xs text-slate-600 font-mono">{data.length} epochs</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <ChartCard title="Accuracy" metric="Acc" data={data}
          trainKey="train_acc" valKey="val_acc"
          trainColor="#22d3ee" valColor="#a78bfa" />
        <ChartCard title="F1 Macro" metric="F1" data={data}
          trainKey="train_f1" valKey="val_f1"
          trainColor="#34d399" valColor="#fb923c" />
      </div>
    </section>
  );
}

function ChartCard({
  title, data, trainKey, valKey, trainColor, valColor,
}: {
  title: string; metric: string;
  data: Record<string, number>[];
  trainKey: string; valKey: string;
  trainColor: string; valColor: string;
}) {
  const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: {name:string;value:number;color:string}[]; label?: number }) => {
    if (!active || !payload?.length) return null;
    return (
      <div className="glass rounded-lg px-3 py-2 border border-white/10 text-xs">
        <p className="text-slate-400 mb-1">Epoch {label}</p>
        {payload.map((p) => (
          <p key={p.name} style={{ color: p.color }}>
            {p.name}: {(p.value * 100).toFixed(1)}%
          </p>
        ))}
      </div>
    );
  };

  return (
    <div className="glass rounded-2xl p-5 border border-white/5 relative overflow-hidden group hover:border-cyan-500/20 transition-colors">
      {/* Gradient glow on hover */}
      <div className="absolute -inset-px rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ background: `radial-gradient(400px at 50% 0%, ${trainColor}08, transparent 60%)` }} />

      <div className="flex items-center justify-between mb-4">
        <p className="font-semibold text-sm text-slate-200">{title}</p>
        <div className="flex items-center gap-3 text-xs text-slate-500">
          <span className="flex items-center gap-1">
            <span className="w-3 h-0.5 inline-block rounded" style={{ background: trainColor }} />Train
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-0.5 inline-block rounded" style={{ background: valColor }} />Val
          </span>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 4, left: -10 }}>
          <defs>
            <linearGradient id={`grad-train-${title}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={trainColor} stopOpacity={0.15} />
              <stop offset="95%" stopColor={trainColor} stopOpacity={0} />
            </linearGradient>
            <linearGradient id={`grad-val-${title}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={valColor} stopOpacity={0.15} />
              <stop offset="95%" stopColor={valColor} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} />
          <XAxis dataKey="epoch" tick={{ fontSize: 10, fill: "#475569" }}
            tickLine={false} axisLine={{ stroke: "rgba(255,255,255,.05)" }} />
          <YAxis domain={[0, 1]} tick={{ fontSize: 10, fill: "#475569" }}
            tickLine={false} axisLine={false}
            tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} />
          <Tooltip content={<CustomTooltip />} cursor={{ stroke: "rgba(255,255,255,.08)" }} />
          <Area type="monotone" dataKey={trainKey} stroke={trainColor}
            strokeWidth={2} fill={`url(#grad-train-${title})`} name="Train" dot={false} />
          <Area type="monotone" dataKey={valKey} stroke={valColor}
            strokeWidth={2} fill={`url(#grad-val-${title})`} name="Val" dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
