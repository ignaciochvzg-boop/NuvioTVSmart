import { I18n } from "../../i18n/index.js";
import { NuvioDialog } from "./nuvioDialog.js";
import { consumePlaybackProbe, shouldReportPlaybackProbe } from "../../core/player/playbackProbe.js";

function t(key, params, fallback) {
  return I18n.t(key, params, { fallback });
}

function compactUrl(url) {
  const value = String(url || "");
  return value.length > 120 ? `${value.slice(0, 117)}...` : value;
}

/**
 * One-shot notice shown on launch when the previous session died during
 * playback without reaching a clean exit. The record is consumed first, so
 * the notice never repeats, and it includes the exact URL that was handed to
 * the engine — the only diagnostics available when the native player kills
 * the process (no dlog access from the app).
 */
export function showPlaybackCrashNoticeIfNeeded(documentRef = globalThis.document) {
  const probe = consumePlaybackProbe();
  if (!probe || !shouldReportPlaybackProbe(probe) || !documentRef?.body) {
    return null;
  }

  const url = String(probe.url || "");
  const message = t(
    "crash_notice_playback",
    { url: compactUrl(url) },
    "Nuvio closed unexpectedly during the last playback attempt (%1$s). This notice helps diagnose the crash."
  );

  const content = documentRef.createElement("div");
  content.className = "playback-crash-notice-content";

  const messageNode = documentRef.createElement("div");
  messageNode.className = "playback-crash-notice-message";
  messageNode.textContent = message;
  content.appendChild(messageNode);

  const urlNode = documentRef.createElement("div");
  urlNode.className = "playback-crash-notice-url";
  urlNode.textContent = url;
  content.appendChild(urlNode);

  let dialog = null;
  const close = () => {
    const activeDialog = dialog;
    dialog = null;
    activeDialog?.destroy();
  };

  dialog = new NuvioDialog({
    title: t("crash_notice_title", {}, "Unexpected close detected"),
    widthVw: 60,
    panelClassName: "playback-crash-notice-dialog",
    content,
    onVerticalNavigate(direction) {
      const previous = urlNode.scrollTop;
      urlNode.scrollTop += direction * Math.max(80, Math.round(urlNode.clientHeight * 0.7));
      return urlNode.scrollTop !== previous;
    },
    buttons: [
      {
        key: "ok",
        label: "OK",
        onAction: close
      }
    ],
    onDismiss: () => {
      dialog = null;
    }
  });
  dialog.mount(documentRef.body);
  return dialog;
}
