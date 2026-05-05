import { NextResponse } from "next/server";
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

const ROOT    = path.resolve(process.cwd(), "..");
const RESULTS = path.join(ROOT, "results");
const STATE   = path.join(RESULTS, "pipeline_state.json");

// Force the route handler dynamic — we don't want Next 14 to cache stale
// pod-log output under any circumstances. Same posture as poll-pod.
export const dynamic = "force-dynamic";

function readState(): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; }
}

// Section delimiters used to split the single SSH call's stdout into
// per-file chunks. Plain ASCII — no escaping concerns. Picked something
// unlikely to appear in setup/orchestrator/training logs.
const SECTION_BEGIN = "<<<CS659_SECTION_BEGIN:";
const SECTION_END   = "<<<CS659_SECTION_END>>>";

interface Section { name: string; ok: boolean; content: string }

function parseSections(stdout: string): Record<string, Section> {
  const out: Record<string, Section> = {};
  // Match: <<<CS659_SECTION_BEGIN:NAME>>>\n...content...\n<<<CS659_SECTION_END>>>
  const re = new RegExp(
    `${SECTION_BEGIN}([A-Z_]+)>>>\\n([\\s\\S]*?)\\n?${SECTION_END}`,
    "g",
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout)) !== null) {
    out[m[1]] = { name: m[1], ok: true, content: m[2] };
  }
  return out;
}

/** Pulls the last N lines of the pod's setup.log + orchestrator.log + screen
 *  session list in a SINGLE SSH connection. Used by the dashboard's "Fetch
 *  pod logs" button when the user suspects the pod is stuck. Read-only —
 *  never mutates state.
 *
 *  Why one SSH call instead of four: the pod's sshd has a MaxStartups cap
 *  that defaults to 10:30:60. Four parallel/sequential ssh subprocesses
 *  per click — plus the user's own terminal — used to trip
 *  "kex_exchange_identification: Connection reset by peer" mid-training.
 *  pod_setup.sh now also raises MaxStartups to 100:30:200, but minimizing
 *  the number of connections is the right fix at this layer too.
 */
export async function GET() {
  const st = readState();
  const podIp   = typeof st.pod_ip   === "string" ? st.pod_ip   : null;
  const podPort = typeof st.pod_port === "number" ? st.pod_port : null;
  if (!podIp || !podPort) {
    return NextResponse.json({
      error: "No pod_ip/pod_port in pipeline_state.json — nothing to query.",
    }, { status: 409 });
  }

  // Single remote command: print all four sections with delimiters.
  // - SCREEN: screen -ls
  // - SETUP:   tail -120 of /workspace/setup.log
  // - ORCH:    tail -120 of /workspace/results/orchestrator.log
  // - TRAIN:   tail -30  of /workspace/results/training.log (\r→\n first to
  //   expand Keras / wget progress bars)
  // Missing files print a clean "[file not found: ...]" placeholder so the
  // section is still present in the response (lets the UI distinguish
  // "didn't run" from "failed to fetch").
  const remoteCmd = `
set +e
emit() { printf '%s%s>>>\\n' '${SECTION_BEGIN}' "$1"; }
done_section() { printf '\\n%s\\n' '${SECTION_END}'; }

emit SCREEN
screen -ls 2>&1 | head -20
done_section

emit SETUP
if [ -f /workspace/setup.log ]; then
  tr '\\r' '\\n' < /workspace/setup.log | tail -n 120
else
  echo "[file not found: /workspace/setup.log]"
fi
done_section

emit ORCH
if [ -f /workspace/results/orchestrator.log ]; then
  tail -n 120 /workspace/results/orchestrator.log
else
  echo "[file not found: /workspace/results/orchestrator.log]"
fi
done_section

emit TRAIN
if [ -f /workspace/results/training.log ]; then
  tr '\\r' '\\n' < /workspace/results/training.log | tail -n 30
else
  echo "[file not found: /workspace/results/training.log]"
fi
done_section
`;

  // NOTE: deliberately NO -n flag here. -n reroutes stdin from /dev/null,
  // which would silence the `input: remoteCmd` we feed to `bash -s`. The
  // earlier multi-call version used -n because it didn't pipe stdin; this
  // single-call version does, so -n was the bug that made every section
  // come back empty.
  const r = spawnSync("ssh", [
    "-T",
    "-p", String(podPort),
    "-o", "StrictHostKeyChecking=no",
    "-o", "ConnectTimeout=20",
    "-o", "ServerAliveInterval=15",
    `root@${podIp}`,
    "bash -s",
  ], {
    input:    remoteCmd,
    encoding: "utf8",
    timeout:  45_000,
  });

  if (r.status !== 0) {
    const err = ((r.stderr || "") + "\n" + (r.stdout || "")).trim().slice(-3000);
    return NextResponse.json({
      podIp,
      podPort,
      error: "ssh failed",
      detail: err,
      // Hint specifically about the kex error so the user can correlate.
      isConnectionReset: /kex_exchange_identification|Connection reset by peer/i.test(err),
    }, { status: 502 });
  }

  const sections = parseSections(r.stdout || "");
  // Hard-cap each chunk so a runaway log can't blow up the network.
  const cap = (s: string | undefined) => (s ?? "").slice(-32_000);

  return NextResponse.json({
    podIp,
    podPort,
    screenSessions:  cap(sections.SCREEN?.content).trim(),
    setupLog:        cap(sections.SETUP?.content),
    orchestratorLog: cap(sections.ORCH?.content),
    trainingLogTail: cap(sections.TRAIN?.content),
  });
}
