import { Platform } from "../../platform/index.js";
import { getTvArtworkPixelRatio } from "../../platform/tvRuntimePerformance.js";

const TMDB_IMAGE_HOST_PATTERN = /^(?:https?:)?\/\/image\.tmdb\.org\//i;

// Poster cards paint at 212-252 CSS px on TV layouts; w185 trades a little
// sharpness for ~70% fewer bytes than w342. Speed matters more than sharpness
// on TV engines that decode every poster on the main thread.
const TMDB_CARD_POSTER_SIZE = "w185";
// Tizen 4/5.0 and webOS 5 and older lack OffscreenCanvas, so tvPosterRescaler
// cannot downscale card posters off the main thread there and every poster
// decodes at its source size. Those panels paint the widest poster card
// (252 CSS px) at one device pixel per CSS pixel; w154 is the smallest size
// that stays acceptable at viewing distance and loads fastest. A 4K panel
// paints at two device pixels per CSS pixel and keeps w185 instead.
const TMDB_LEGACY_TV_CARD_POSTER_SIZE = "w154";

let cachedCardPosterSize = null;

function tvCanUseSmallCardPosters() {
  // A rescaler-less TV that paints at one device pixel per CSS pixel can take
  // w185; a panel that paints larger keeps w342 so it stays sharp.
  const isTv = Boolean(Platform.isTizen?.() || Platform.isWebOS?.());
  return isTv && typeof OffscreenCanvas === "undefined" && getTvArtworkPixelRatio() === 1;
}

/**
 * TMDB size used for poster-shaped Home/library cards. Computed once per run.
 */
export function preferredTmdbCardPosterSize() {
  if (cachedCardPosterSize === null) {
    cachedCardPosterSize = tvCanUseSmallCardPosters()
      ? TMDB_LEGACY_TV_CARD_POSTER_SIZE
      : TMDB_CARD_POSTER_SIZE;
  }
  return cachedCardPosterSize;
}

export function resetPreferredTmdbCardPosterSizeForTests() {
  cachedCardPosterSize = null;
}

/**
 * Cap backdrops at w300 on this port: w1280/w780/w500 cost up to ~10x the
 * bytes and TV engines without OffscreenCanvas decode every backdrop on the
 * main thread. w300 keeps hero/detail backgrounds fast to fetch and decode;
 * art this soft reads as cinematic background behind text, not as detail.
 */
export function normalizeTmdbBackdropUrl(value) {
  const normalized = String(value || "").trim();
  if (!normalized || !TMDB_IMAGE_HOST_PATTERN.test(normalized)) {
    return normalized;
  }
  return normalized.replace(/(\/t\/p\/)(?:original|w1280|w780|w500)\//i, "$1w300/");
}

// Addon metas (AIOMetadata, ...) hand the hero logo over as the TMDB original,
// which is often a multi-megapixel PNG: the TV decodes all of it to paint a
// 440x200 box. w500 is TMDB's largest logo size and what Android TV's Coil
// target already produces, so the visible result is unchanged.
export function normalizeTmdbLogoUrl(value) {
  const normalized = String(value || "").trim();
  if (!normalized || !TMDB_IMAGE_HOST_PATTERN.test(normalized)) {
    return normalized;
  }
  return normalized.replace(/(\/t\/p\/)original\//i, "$1w500/");
}

export function normalizeTmdbPosterUrl(value) {
  const normalized = String(value || "").trim();
  if (!normalized || !TMDB_IMAGE_HOST_PATTERN.test(normalized)) {
    return normalized;
  }
  const size = preferredTmdbCardPosterSize();
  // Addon catalogs (TMDB addon, AIOMetadata, ...) send w500/w780 posters
  // directly; trade every oversized TMDB source down to the card size so a
  // slow network never waits on pixels the card cannot show.
  const oversized =
    size === TMDB_CARD_POSTER_SIZE
      ? /(\/t\/p\/)(?:original|w780|w500|w342)\//i
      : /(\/t\/p\/)(?:original|w780|w500|w342|w185)\//i;
  return normalized.replace(oversized, `$1${size}/`);
}
