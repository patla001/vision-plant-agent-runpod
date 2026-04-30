"use client";

const STEPS = [
  { key: "provision", label: "Provision",  icon: "⚡" },
  { key: "launch",    label: "Launch",     icon: "🚀" },
  { key: "training",  label: "Training",   icon: "🧠" },
  { key: "download",  label: "Download",   icon: "📥" },
  { key: "analyze",   label: "Analyze",    icon: "📊" },
];

function stepIndex(currentStep: string): number {
  const s = currentStep.toLowerCase();
  if (s.includes("provision") || s.includes("waiting for pod") || s.includes("pod created")) return 0;
  if (s.includes("upload") || s.includes("download") && s.includes("dataset") || s.includes("launch") || s.includes("started")) return 1;
  if (s.includes("training") || s.includes("monitor") || s.includes("check") || s.includes("progress") || s.includes("next check") || s.includes("cnn")) return 2;
  if (s.includes("download") && s.includes("result")) return 3;
  if (s.includes("analy") || s.includes("terminat") || s.includes("billing")) return 4;
  return 0;
}

interface Props { currentStep: string; status: string }

export default function PipelineSteps({ currentStep, status }: Props) {
  const active = status === "done" ? STEPS.length : stepIndex(currentStep);

  return (
    <div className="glass rounded-2xl p-5">
      <div className="flex items-center justify-between overflow-x-auto gap-1 pb-1">
        {STEPS.map((step, i) => {
          const done    = status === "done" || i < active;
          const current = status !== "done" && i === active;
          return (
            <div key={step.key} className="flex items-center flex-shrink-0">
              <div className="flex flex-col items-center gap-1.5 min-w-[72px]">
                {/* Circle indicator */}
                <div className={`relative w-10 h-10 rounded-full flex items-center justify-center text-base font-bold transition-all duration-500 ${
                  done
                    ? "bg-gradient-to-br from-cyan-500 to-violet-600 shadow-neon-cyan text-white"
                    : current
                    ? "bg-gradient-to-br from-amber-400 to-orange-500 text-gray-900 animate-glow-pulse"
                    : "bg-slate-800/80 text-slate-500 border border-white/5"
                }`}>
                  {done ? "✓" : step.icon}
                  {current && (
                    <span className="absolute inset-0 rounded-full border-2 border-amber-400 animate-ping opacity-40" />
                  )}
                </div>
                <span className={`text-[11px] font-medium text-center leading-tight ${
                  done ? "text-cyan-400" : current ? "text-amber-300" : "text-slate-600"
                }`}>
                  {step.label}
                </span>
              </div>

              {/* Connector line */}
              {i < STEPS.length - 1 && (
                <div className={`h-0.5 w-6 sm:w-10 mb-5 mx-1 rounded-full flex-shrink-0 transition-all duration-700 ${
                  i < active ? "step-line-done" : "step-line-todo"
                }`} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
