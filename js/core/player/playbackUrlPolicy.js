// AVPlay on Tizen 3 can terminate the whole app process when it is handed a
// URL it cannot open: exotic schemes (magnet:, data:, javascript:) or links
// with unescaped spaces/non-ASCII characters (e.g. a literal "ñ" from a
// source addon) reach avplay.open() and crash natively, outside any
// try/catch. Every playback URL therefore passes through this gate first:
// unsupported schemes fail with a user-visible error instead of a crash, and
// http(s) links containing dangerous bytes are re-serialized through WHATWG
// URL so the bytes AVPlay receives are always percent-encoded.
const ALLOWED_SCHEMES = new Set([
  "http:",
  "https:",
  "rtmp:",
  "rtsp:",
  "mms:",
  "mmsh:",
  "file:",
  "blob:"
]);

// Anything outside printable ASCII, plus the space that commonly sneaks in
// from addon-generated filenames/queries, is what AVPlay chokes on.
const NEEDS_NORMALIZATION = /[^\x21-\x7e]/;

/**
 * Returns a playback-safe URL, or null when this TV cannot open the link.
 * Well-formed ASCII links are passed through byte-for-byte; only links with
 * dangerous characters are re-serialized (`new URL().href` percent-encodes
 * spaces, non-ASCII and control characters).
 */
export function toSafePlaybackUrl(rawUrl) {
  const raw = String(rawUrl || "").trim();
  if (!raw) {
    return null;
  }
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
  if (!schemeMatch) {
    // Protocol-relative or malformed: never hand these to AVPlay.
    return null;
  }
  const scheme = `${schemeMatch[1].toLowerCase()}:`;
  if (!ALLOWED_SCHEMES.has(scheme)) {
    return null;
  }
  if (scheme === "http:" || scheme === "https:") {
    if (!NEEDS_NORMALIZATION.test(raw)) {
      // Still validate: a link that WHATWG URL refuses to parse (bad host,
      // invalid port, control characters) is exactly the kind AVPlay dies on.
      try {
        new URL(raw);
      } catch (_) {
        return null;
      }
      return raw;
    }
    try {
      return new URL(raw).href;
    } catch (_) {
      // Unparseable http(s) link (bad host, control chars): reject instead
      // of forwarding something AVPlay may die on.
      return null;
    }
  }
  return raw;
}

export function isSafePlaybackUrl(rawUrl) {
  return toSafePlaybackUrl(rawUrl) !== null;
}
