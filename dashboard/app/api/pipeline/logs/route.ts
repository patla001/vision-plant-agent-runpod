import fs from "fs";
import path from "path";

const LOG = path.join(path.resolve(process.cwd(), ".."), "results", "pipeline.log");

export async function GET(request: Request) {
  const encoder = new TextEncoder();
  let offset = 0;

  const stream = new ReadableStream({
    start(controller) {
      const tick = () => {
        try {
          if (!fs.existsSync(LOG)) {
            controller.enqueue(encoder.encode("data: []\n\n"));
            return;
          }
          const size = fs.statSync(LOG).size;
          if (size > offset) {
            const fd  = fs.openSync(LOG, "r");
            const buf = Buffer.alloc(size - offset);
            fs.readSync(fd, buf, 0, buf.length, offset);
            fs.closeSync(fd);
            offset = size;
            const lines = buf.toString("utf8").split("\n").filter(Boolean);
            if (lines.length) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(lines)}\n\n`));
            }
          }
        } catch { /* file not ready yet */ }
      };

      // Send existing content immediately, then poll
      tick();
      const interval = setInterval(tick, 2000);

      request.signal.addEventListener("abort", () => {
        clearInterval(interval);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection":    "keep-alive",
    },
  });
}
