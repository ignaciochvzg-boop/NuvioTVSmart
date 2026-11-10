// Diagnóstico de arranque en la TV: una sola conexión, en orden:
//   1. batería de estado en t0 (antes de que se congele el hilo)
//   2. habilitar Runtime/Console y validar el canal con un console.log
//   3. sondeo cada 2s para detectar el instante de congelación
//   4. Page.captureScreenshot a mitad de captura (el compositor puede
//      responder aunque el hilo principal esté bloqueado)
//   5. batería final
//
//   node scripts/boot_diag.mjs <ws-url> [archivo-salida-png]
import { writeFileSync } from "node:fs";

const wsUrl = process.argv[2];
const shotPath = process.argv[3] || "tv_shot.png";
if (!wsUrl) {
  console.error("uso: node scripts/boot_diag.mjs <ws://...> [out.png]");
  process.exit(1);
}

const ws = new WebSocket(wsUrl);
let nextId = 1;
const pending = new Map();

function send(method, params = {}, timeoutMs = 5000) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout ${method}`));
      }
    }, timeoutMs);
  });
}

const BATTERY =
  "(function(){try{return JSON.stringify({" +
  "ready:document.readyState," +
  "now:Math.round(performance.now())," +
  "scripts:[].map.call(document.scripts,function(s){return (s.src||'inline:'+s.textContent.slice(0,30)).split('/').pop();})," +
  "styles:document.styleSheets.length," +
  "cssvarsOut:document.querySelectorAll('style[data-cssvars]').length," +
  "bodyKids:document.body?document.body.children.length:-1," +
  "bodyLen:document.body?document.body.innerHTML.length:-1," +
  "guard:window.NuvioBootGuard?window.NuvioBootGuard.isActive():null," +
  "env:typeof window.__NUVIO_ENV__," +
  "cssVarsFn:typeof window.cssVars," +
  "tizen:typeof window.tizen," +
  "webapis:typeof window.webapis" +
  "});}catch(e){return 'ERR:'+e.message}})()";

const t0 = Date.now();
function log(msg) {
  console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
}

async function battery(tag) {
  try {
    const r = await send("Runtime.evaluate", { expression: BATTERY, returnByValue: true }, 3000);
    log(`BATERIA ${tag}: ${r.result?.value}`);
    return true;
  } catch (e) {
    log(`BATERIA ${tag}: SIN RESPUESTA (${e.message})`);
    return false;
  }
}

let froze = false;
let shotTaken = false;

ws.addEventListener("open", async () => {
  // 1) bateria inmediata, antes que nada
  await battery("t0");

  for (const d of ["Runtime", "Console"]) {
    try {
      await send(`${d}.enable`);
      log(`${d}.enable OK`);
    } catch (e) {
      log(`${d}.enable fallo: ${e.message}`);
    }
  }

  // 2) validar canal de consola
  try {
    await send("Runtime.evaluate", { expression: "console.log('BOOTMARK');'ok'" , returnByValue: true }, 3000);
    log("console.log emitido");
  } catch (e) {
    log(`no se pudo emitir console.log: ${e.message}`);
  }

  // 3) sondeo cada 2s
  const poll = setInterval(async () => {
    const alive = await battery(`t+${((Date.now() - t0) / 1000).toFixed(0)}s`);
    if (!alive && !froze) {
      froze = true;
      log(">>> HILO CONGELADO A PARTIR DE AQUI");
    }
  }, 2000);

  // 4) captura de pantalla a los 12s (intenta aunque este congelado)
  setTimeout(async () => {
    try {
      const r = await send("Page.captureScreenshot", { format: "png" }, 6000);
      if (r.data) {
        writeFileSync(shotPath, Buffer.from(r.data, "base64"));
        shotTaken = true;
        log(`captura guardada en ${shotPath} (${r.data.length} bytes b64)`);
      }
    } catch (e) {
      log(`captura fallo: ${e.message}`);
    }
  }, 12000);

  // 5) batería final + fin
  setTimeout(async () => {
    clearInterval(poll);
    await battery("final");
    if (!shotTaken) {
      try {
        const r = await send("Page.captureScreenshot", { format: "png" }, 6000);
        if (r.data) {
          writeFileSync(shotPath, Buffer.from(r.data, "base64"));
          log(`captura final guardada en ${shotPath}`);
        }
      } catch (e) {
        log(`captura final fallo: ${e.message}`);
      }
    }
    process.exit(0);
  }, 30000);
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
    const parts = (msg.params.args || []).map((a) => String(a.value ?? a.description ?? ""));
    log(`CONSOLA [${msg.params.type}] ${parts.join(" ")}`);
  } else if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    log(`EXCEPCION: ${d.exception?.description || d.text}`);
  }
});

ws.addEventListener("error", (e) => log(`ws error: ${e.message || "fallo de conexion"}`));
ws.addEventListener("close", (e) => log(`ws close code=${e.code}`));

setTimeout(() => {
  log("fin global 40s");
  process.exit(0);
}, 40000);
