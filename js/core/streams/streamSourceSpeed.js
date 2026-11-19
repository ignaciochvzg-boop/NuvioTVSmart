// Measured answer time per source. streamRepository stamps
// `requestDurationMs` on every addon/plugin group when its stream request
// settles, so the stream list can show how fast each source responded and
// single out the ones that are both quick and ready to play.
export const STREAM_SOURCE_SPEED_FAST_MS = 2000;
export const STREAM_SOURCE_SPEED_OK_MS = 5000;

/** The measured answer time in ms, or null when this run did not measure it. */
export function streamSourceSpeedMs(stream = {}) {
  const value = Number(stream?.requestDurationMs);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** "fast" | "ok" | "slow", or null when there is no measurement. */
export function streamSourceSpeedTier(durationMs) {
  const value = Number(durationMs);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  if (value <= STREAM_SOURCE_SPEED_FAST_MS) {
    return "fast";
  }
  if (value <= STREAM_SOURCE_SPEED_OK_MS) {
    return "ok";
  }
  return "slow";
}

/** Compact chip copy: "0.9s", "4.2s", "13s". */
export function formatStreamSourceSpeed(durationMs) {
  const seconds = Number(durationMs) / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

/**
 * Recommended = the source answered fast and is playable right now: a plain
 * locator (http/torrent/yt) or a debrid item that is already cached. A
 * debrid item that is not cached yet would only add a resolve round-trip,
 * so it never gets the star even when the list request was quick.
 */
export function isStreamSourceRecommended(stream = {}) {
  const durationMs = streamSourceSpeedMs(stream);
  if (streamSourceSpeedTier(durationMs) !== "fast") {
    return false;
  }
  const cacheState = String(stream?.debridCacheStatus?.state || "")
    .trim()
    .toUpperCase();
  if (cacheState && cacheState !== "CACHED") {
    return false;
  }
  return Boolean(stream?.url || stream?.externalUrl || stream?.infoHash || stream?.ytId);
}
