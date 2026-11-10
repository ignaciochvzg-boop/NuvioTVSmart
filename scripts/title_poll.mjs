// Polls the Web Inspector /json listing of the TV and prints a timeline of
// document.title changes. This is the out-of-band boot progress channel: the
// HTTP endpoint keeps answering even while the renderer's main thread is
// frozen, so the last title seen marks the exact boot stage where the app
// hangs (see markBootStage in js/app.js and the markers in buildIndexHtml).
//
//   node scripts/title_poll.mjs <port> [seconds] [host]
//
// Run it right after `0 debug <appid>` over SDB prints the debug port.
// host defaults to the TV (192.168.1.77); pass 127.0.0.1 to watch a local
// headless Chromium rendering the same bundle (fast desktop reproduction).

const port = process.argv[2];
const seconds = Number(process.argv[3] || 60);
const host = process.argv[4] || "192.168.1.77";
if (!port) {
  console.error("uso: node scripts/title_poll.mjs <puerto> [segundos] [host]");
  process.exit(1);
}

const base = `http://${host}:${port}`;
const startedAt = Date.now();

function fmt(ms) {
  return `+${(ms / 1000).toFixed(1)}s`;
}

async function once() {
  const res = await fetch(`${base}/json`, { signal: AbortSignal.timeout(3000) });
  const list = await res.json();
  const page = list.find((t) => t.type === "page") || list[0];
  return page ? `${page.title} | ${page.url}` : "(sin objetivos)";
}

let last = null;
let consecutiveErrors = 0;

console.log(`sondeando ${base}/json durante ${seconds}s ...`);
while ((Date.now() - startedAt) / 1000 < seconds) {
  try {
    const now = await once();
    consecutiveErrors = 0;
    if (now !== last) {
      console.log(`[${fmt(Date.now() - startedAt)}] ${now}`);
      last = now;
    }
  } catch (e) {
    consecutiveErrors += 1;
    if (consecutiveErrors === 1 || consecutiveErrors % 10 === 0) {
      console.log(`[${fmt(Date.now() - startedAt)}] /json fallo: ${e.message}`);
    }
    if (consecutiveErrors >= 5 && last && !last.includes("RENDERER MUERTO")) {
      console.log(`[${fmt(Date.now() - startedAt)}] RENDERER MUERTO (el inspector dejo de responder)`);
      last = `${last} | RENDERER MUERTO`;
    }
  }
  await new Promise((r) => setTimeout(r, 500));
}
console.log("fin del sondeo");
