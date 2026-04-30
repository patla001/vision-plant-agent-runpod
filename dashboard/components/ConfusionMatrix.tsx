"use client";

interface Props { run: string; pngs: string[] }

const MATRIX_FILES = [
  { file: "val_confusion_matrix_normalized.png",  label: "Val — Normalized",  color: "cyan" },
  { file: "test_confusion_matrix_normalized.png", label: "Test — Normalized", color: "purple" },
  { file: "val_confusion_matrix_raw.png",         label: "Val — Raw counts",  color: "cyan" },
  { file: "test_confusion_matrix_raw.png",        label: "Test — Raw counts", color: "purple" },
];

type CardColor = "cyan" | "purple";

const COLOR: Record<CardColor, { border: string; dot: string; text: string }> = {
  cyan:   { border: "border-cyan-500/25",   dot: "bg-cyan-400",   text: "text-cyan-400" },
  purple: { border: "border-violet-500/25", dot: "bg-violet-400", text: "text-violet-400" },
};

export default function ConfusionMatrix({ run, pngs }: Props) {
  const available = MATRIX_FILES.filter((m) => pngs.includes(m.file));
  if (!available.length) return (
    <p className="text-slate-600 text-sm italic">No confusion matrix images found.</p>
  );

  return (
    <section>
      <div className="flex items-center gap-3 mb-5">
        <h2 className="text-lg font-bold gradient-text-cyan-purple">Confusion Matrices</h2>
        <span className="text-xs text-slate-600">{available.length} available</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        {available.map(({ file, label, color }) => {
          const c = COLOR[color as CardColor];
          return (
            <div key={file} className={`glass rounded-2xl border ${c.border} overflow-hidden group hover:border-opacity-50 transition-all`}>
              {/* Card header */}
              <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-white/5">
                <span className={`w-2 h-2 rounded-full ${c.dot}`} />
                <span className={`text-xs font-medium ${c.text}`}>{label}</span>
              </div>
              {/* Image */}
              <div className="p-2 bg-black/20">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/image?run=${encodeURIComponent(run)}&file=${encodeURIComponent(file)}`}
                  alt={label}
                  className="w-full object-contain rounded-lg group-hover:scale-[1.01] transition-transform duration-300"
                />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
