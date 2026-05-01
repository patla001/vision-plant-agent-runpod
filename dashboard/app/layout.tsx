import type { Metadata } from "next";
import dynamic from "next/dynamic";
import "./globals.css";

const HeaderGem = dynamic(() => import("@/components/HeaderGem"), { ssr: false });

export const metadata: Metadata = {
  title: "CS659 — Plant Classifier AI",
  description: "Multi-agent CNN training pipeline for PlantNet-300K",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        {/* Header */}
        <header className="sticky top-0 z-50 glass border-b border-white/5">
          <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              {/* Three.js rotating gem logo */}
              <HeaderGem size={36} />
              <div>
                <h1 className="text-base font-bold gradient-text-cyan-purple tracking-tight">
                  CS659 Plant Classifier
                </h1>
                <p className="text-[10px] text-slate-500 -mt-0.5">
                  MobileNetV2 · PlantNet-300K · Multi-Agent Pipeline
                </p>
              </div>
            </div>

            {/* Badge row */}
            <div className="hidden sm:flex items-center gap-2">
              {[
                { label: "H100 80GB", color: "cyan" },
                { label: "RunPod",   color: "purple" },
                { label: "Claude",   color: "green" },
              ].map(({ label, color }) => (
                <span
                  key={label}
                  className={`text-[10px] px-2.5 py-0.5 rounded-full border font-medium
                    ${color === "cyan"   ? "border-cyan-500/30   text-cyan-400   bg-cyan-500/5"   : ""}
                    ${color === "purple" ? "border-violet-500/30 text-violet-400 bg-violet-500/5" : ""}
                    ${color === "green"  ? "border-emerald-500/30 text-emerald-400 bg-emerald-500/5" : ""}
                  `}
                >
                  {label}
                </span>
              ))}
            </div>
          </div>

          {/* Neon accent line */}
          <div className="h-px bg-gradient-to-r from-transparent via-cyan-500/50 to-transparent" />
        </header>

        <main className="max-w-6xl mx-auto px-6 py-8 space-y-10">
          {children}
        </main>

        {/* Footer glow */}
        <div className="fixed bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-violet-500/20 to-transparent pointer-events-none" />
      </body>
    </html>
  );
}
