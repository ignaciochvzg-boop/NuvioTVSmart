// Chrome DevTools Protocol client for the TV (Chromium 47 / Tizen 3.0).
//
// The TV opens a Web Inspector port when launched with `0 debug <appid>` over
// SDB (see scripts/sdb_cmd.py); the port is printed by the launcher and listed
// at http://<tv>:<port>/json. Node's built-in WebSocket speaks CDP directly,
// so no dependencies are needed.
//
//   node scripts/cdp.mjs ws://192.168.1.77:59439/devtools/page/<id>
//   node scripts/cdp.mjs <url> --seconds 8            # collect console output
//   node scripts/cdp.mjs <url> --eval "document.title"
//   node scripts/cdp.mjs <url> --eval-file probe.js   # evaluate a file

const args = process.argv.slice(2);
const wsUrl = args.find((a) => a.startsWith("ws://"));
if (!wsUrl) {
  console.error("usage: node scripts/cdp.mjs <ws://...> [--seconds N] [--eval <js>] [--eval-file <path>]");
  process.exit(1);
}
const secondsIndex = args.indexOf("--seconds");
const seconds = secondsIndex >= 0 ? Number(args[secondsIndex + 1]) : 6;
const evalIndex = args.indexOf("--eval");
const evalFileIndex = args.indexOf("--eval-file");
let evalSource = null;
if (evalIndex >= 0) evalSource = args[evalIndex + 1];
if (evalFileIndex >= 0) {
  const { readFileSync } = await import("node:fs");
  evalSource = readFileSync(args[evalFileIndex + 1], "utf8");
}

const ws = new WebSocket(wsUrl);
let nextId = 1;
const pending = new Map();
const events = [];

function send(method, params = {}, timeoutMs = 6000) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    // The renderer freezes or dies a few seconds after boot on the TV, so a
    // command may never be answered: fail the caller instead of hanging.
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout esperando respuesta de ${method}`));
      }
    }, timeoutMs);
  });
}

function describeConsole(msg) {
  // CDP Console API messages arrive on Runtime.consoleAPICalled.
  const args2 = (msg.args || []).map((a) => {
    if (a.type === "string" || a.type === "number" || a.type === "boolean") return String(a.value);
    if (a.type === "undefined") return "undefined";
    if (a.type === "function") return "ƒ";
    if (a.unserializableValue) return a.unserializableValue;
    if (a.description) return a.description;
    return JSON.stringify(a.value ?? null);
  });
  return `[${msg.type}] ${args2.join(" ")}`;
}

ws.addEventListener("open", async () => {
  const startedAt = Date.now();
  try {
    // Dominios que el Chrome 47 no tiene (Log es de CDP posterior) no deben
    // abortar la captura.
    const tryEnable = async (domain) => {
      try {
        await send(`${domain}.enable`);
      } catch (e) {
        console.log(`[cdp] ${domain}.enable no disponible: ${e.message}`);
      }
    };
    await tryEnable("Runtime");
    await tryEnable("Console");
    await tryEnable("Log");
    await tryEnable("Page");

    if (evalSource) {
      const result = await send("Runtime.evaluate", {
        expression: evalSource,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        console.log("EXCEPCION: " + (result.exceptionDetails.exception?.description || result.exceptionDetails.text));
      } else {
        const v = result.result.value;
        console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
      }
      ws.close();
      process.exit(0);
    }

    console.log(`--- capturando consola ${seconds}s ---`);

    // Sondeo inmediato + cada 2s: localiza el instante en que el hilo
    // principal deja de responder (congelacion vs muerte de la app).
    const probeOnce = async (tag) => {
      try {
        const r = await send("Runtime.evaluate", { expression: "1", returnByValue: true }, 2500);
        console.log(`[sonda ${tag}] hilo vivo (value=${r.result?.value})`);
        return true;
      } catch (e) {
        console.log(`[sonda ${tag}] SIN RESPUESTA: ${e.message}`);
        return false;
      }
    };
    await probeOnce("t0");
    const pollTimer = setInterval(async () => {
      await probeOnce(`t+${Math.round((Date.now() - startedAt) / 1000)}s`);
    }, 2000);

    setTimeout(async () => {
      clearInterval(pollTimer);
      try {
        // Estado de la pagina al final de la captura.
        const probe = await send("Runtime.evaluate", {
          expression:
            "JSON.stringify({title: document.title, ready: document.readyState, " +
            "body: document.body ? document.body.children.length : -1, " +
            "text: (document.body && document.body.innerText || '').slice(0, 300)})",
          returnByValue: true,
        });
        console.log("--- estado de la pagina ---");
        console.log(probe.result?.value);
      } catch (e) {
        console.log("sonda final fallo: " + e.message);
      }
      if (events.length === 0) console.log("(sin eventos de consola)");
      ws.close();
      process.exit(0);
    }, seconds * 1000);
  } catch (e) {
    console.error("error CDP: " + e.message);
    process.exit(1);
  }
});

ws.addEventListener("message", (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw.data);
  } catch {
    return;
  }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
    return;
  }
  if (msg.method === "Runtime.consoleAPICalled") {
    const line = describeConsole(msg);
    events.push(line);
    console.log("CONSOLE " + line);
  } else if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    const desc = d.exception?.description || d.text;
    events.push("EXCEPTION " + desc);
    console.log("EXCEPTION " + desc);
    if (d.stackTrace) {
      for (const f of d.stackTrace.callFrames.slice(0, 6)) {
        console.log(`    at ${f.functionName || "<anonymous>"} (${f.url.split("/").pop()}:${f.lineNumber + 1})`);
      }
    }
  } else if (msg.method === "Log.entryAdded") {
    const e = msg.params.entry;
    if (e.level === "error" || e.level === "warning") {
      const line = `[log.${e.level}] ${e.text} ${e.url || ""}`;
      events.push(line);
      console.log("LOG " + line);
    }
  } else if (msg.method) {
    // Chrome 47 may report console output with legacy method names (for
    // example Console.messageAdded instead of Runtime.consoleAPICalled).
    // Dump unknown methods raw so no signal is lost.
    const line = `RAW ${msg.method} ${JSON.stringify(msg.params).slice(0, 500)}`;
    events.push(line);
    console.log(line);
  }
});

ws.addEventListener("error", (e) => {
  console.error("ws error: " + (e.message || "connection failed"));
  process.exit(1);
});

ws.addEventListener("close", (e) => {
  if (!process.exitCode) process.exit(0);
});

setTimeout(() => {
  console.error("timeout global");
  process.exit(2);
}, (seconds + 30) * 1000);
