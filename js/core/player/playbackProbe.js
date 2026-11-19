// Crash breadcrumb for playback. AVPlay can terminate the whole app process
// natively (outside any try/catch), so the only way to learn which URL killed
// it is to leave a record in localStorage before handing the link to the
// engine and read it back on the next boot. The record is removed on a clean
// player exit (cleanup/pagehide), on the first presented frame it is promoted
// to a heartbeat, and a surviving record means the process died abruptly.
import { LocalStore } from "../storage/localStore.js";

const PROBE_KEY = "nuvio_playback_crash_probe";
const MAX_URL_CHARS = 400;
// The record only survives an abrupt process death (cleanup and pagehide both
// remove it), so its mere existence is the signal; the window just keeps an
// old breadcrumb from being reported days later. Ten minutes covers a manual
// relaunch right after the crash while ignoring a TV that was simply powered
// off mid-episode and turned back on much later.
const REPORT_WINDOW_MS = 10 * 60 * 1000;
const HEARTBEAT_MIN_INTERVAL_MS = 10 * 1000;

let lastHeartbeatAt = 0;

function readProbe() {
  const record = LocalStore.get(PROBE_KEY, null);
  return record && typeof record === "object" ? record : null;
}

export function beginPlaybackProbe(url = "", extra = {}) {
  try {
    const now = Date.now();
    lastHeartbeatAt = now;
    LocalStore.set(PROBE_KEY, {
      url: String(url || "").slice(0, MAX_URL_CHARS),
      stage: "starting",
      startedAt: now,
      updatedAt: now,
      ...(extra || {})
    });
  } catch (_) {
    // Diagnostics must never break playback.
  }
}

export function markPlaybackProbePresented() {
  try {
    const record = readProbe();
    if (!record) {
      return;
    }
    const now = Date.now();
    lastHeartbeatAt = now;
    record.stage = "presented";
    record.updatedAt = now;
    LocalStore.set(PROBE_KEY, record);
  } catch (_) {
    // Ignore probe failures.
  }
}

/** Cheap heartbeat; safe to call on every UI tick (self-throttled). */
export function touchPlaybackProbe() {
  try {
    const now = Date.now();
    if (now - lastHeartbeatAt < HEARTBEAT_MIN_INTERVAL_MS) {
      return;
    }
    const record = readProbe();
    if (!record || record.stage !== "presented") {
      return;
    }
    lastHeartbeatAt = now;
    record.updatedAt = now;
    LocalStore.set(PROBE_KEY, record);
  } catch (_) {
    // Ignore probe failures.
  }
}

export function clearPlaybackProbe() {
  try {
    lastHeartbeatAt = 0;
    LocalStore.remove(PROBE_KEY);
  } catch (_) {
    // Ignore probe failures.
  }
}

/** Reads and removes the record: the notice is one-shot. */
export function consumePlaybackProbe() {
  try {
    const record = readProbe();
    LocalStore.remove(PROBE_KEY);
    lastHeartbeatAt = 0;
    return record;
  } catch (_) {
    return null;
  }
}

export function shouldReportPlaybackProbe(record, now = Date.now()) {
  if (!record || typeof record !== "object") {
    return false;
  }
  const updatedAt = Number(record.updatedAt || record.startedAt || 0);
  if (!updatedAt) {
    return false;
  }
  return Math.max(0, now - updatedAt) <= REPORT_WINDOW_MS;
}
