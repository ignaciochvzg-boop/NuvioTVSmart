import { newerServerResume } from "../../../data/mediaserver/mediaServerUserState.js";
import { WatchProgressStore } from "../../../data/local/watchProgressStore.js";
import { MediaServerRepository, canResolveMediaServerStream } from "../../../data/mediaserver/mediaServerRepository.js";
import { getStreamUrlExpiryTimestampMs } from "../../../core/player/hlsNetworkErrorPolicy.js";
import { invalidateResolvedStreamCache } from "../../../core/debrid/directDebridResolver.js";
/* eslint-disable no-unused-vars */
import * as internals from "./playerScreenContext.js";

// Signed stream links typically live ~15 minutes from resolution. Check every
// 5 minutes and re-resolve + resume BEFORE the signature dies so playback
// never reaches a cut. Links without a detectable TTL are covered by the
// reactive recovery in showExpiredStreamError.
const STREAM_URL_REFRESH_TICK_MS = 5 * 60 * 1000;
const STREAM_URL_REFRESH_LEAD_MS = 5 * 60 * 1000;

export function createPlayerScreenMethods35() {
  const {
    streamRepository,
    TorrentSettingsStore,
    DirectDebridResolver,
    WebOsEngineFsResolver,
    TizenStreamingServerResolver,
    logEngineFsDebug,
    getP2pInfoHash,
    t,
    streamDirectPlaybackUrl,
    flattenStreamGroups,
    normalizeItemType
  } = internals;

  return {
    tryServerPlaybackFallback(streamCandidate = this.getCurrentStreamCandidate()) {
      const playback = streamCandidate?.serverPlayback || streamCandidate?.raw?.serverPlayback;
      if (!this.activePlaybackUrl || playback?.playMethod !== "DirectPlay" || !canResolveMediaServerStream(streamCandidate)) return false;
      if (playback.fallbackRequested) return true;
      playback.fallbackRequested = true;
      if (!this.pendingPlaybackRestore) {
        this.pendingPlaybackRestore = {
          timeSeconds: this.getPlaybackCurrentSeconds(),
          paused: this.paused,
          attempts: 0,
          lastAttemptAt: 0
        };
      }
      void this.playStreamCandidate(streamCandidate, {
        serverFallbackUrl: this.activePlaybackUrl,
        preservePlaybackState: true,
        mountToken: this.playerMountToken
      });
      return true;
    },
    /**
     * Re-resolve the current stream and resume at the same position. Used
     * reactively when a signed URL dies mid-playback and proactively by the
     * 5-minute refresh ticker before it dies. Returns true once a
     * replacement attempt has been started for this URL.
     */
    async recoverExpiredStreamPlayback({
      playbackUrl = "",
      sourceCandidate = null,
      reason = "stream-url-expired",
      markFailed = true
    } = {}) {
      const urlKey = String(playbackUrl || this.activePlaybackUrl || "").trim();
      if (!urlKey || !this.playerRouteActive) {
        return false;
      }
      // Collapse concurrent error events for the same player into one attempt.
      if (this.expiredStreamRecoveryInFlight) {
        return false;
      }
      // Sliding retry budget: at most 3 attempts per 3-minute window. The
      // window refills on its own, so a 2-3 hour movie never runs out of
      // recoveries (each 5-minute proactive tick lands in a fresh window),
      // while a burst of failures for the same dead link still terminates
      // in the sources panel instead of looping.
      const recoveryNow = Date.now();
      if (recoveryNow - Number(this.expiredStreamRecoveryWindowAt || 0) > 3 * 60 * 1000) {
        this.expiredStreamRecoveryWindowAt = recoveryNow;
        this.expiredStreamRecoveryAttempts = 0;
      }
      if (Number(this.expiredStreamRecoveryAttempts || 0) >= 3) {
        return false;
      }
      const candidate = sourceCandidate || this.getStreamCandidateByUrl(urlKey) || this.getCurrentStreamCandidate();
      if (!candidate) {
        return false;
      }
      this.expiredStreamRecoveryInFlight = true;
      this.expiredStreamRecoveryAttempts = Number(this.expiredStreamRecoveryAttempts || 0) + 1;
      try {
        // Capture the position before the engine state is torn down; the
        // reopen consumes pendingPlaybackRestore on the next prepared event.
        const resumeSeconds = Math.max(
          Number(this.getPlaybackCurrentSeconds()) || 0,
          Number(this.lastStablePlaybackSeconds) || 0
        );
        if (resumeSeconds > 1) {
          this.pendingPlaybackRestore = {
            timeSeconds: resumeSeconds,
            paused: Boolean(this.paused),
            attempts: 0,
            lastAttemptAt: 0
          };
        }
        if (markFailed) {
          this.markPlaybackSourceFailed(urlKey, candidate);
        }
        const mountToken = this.playerMountToken;
        const fresh = await this.resolveFreshStreamCandidate(candidate, urlKey);
        if (!fresh || !this.isActiveMountToken(mountToken)) {
          return false;
        }
        console.warn("Re-resolving stream URL before it cuts playback", {
          reason,
          resumeSeconds,
          streamId: String(fresh.id || "")
        });
        // playStreamByUrl only resets engine validation when it drops the
        // presented frame; preserving the frame above means the new link has
        // to re-prove itself here instead.
        this.resetPlaybackEngineValidation();
        await this.playStreamCandidate(fresh, {
          preservePlaybackState: true,
          // Mid-playback recovery must not drop back to the startup overlay:
          // keeping the presented frame shows the buffering spinner instead,
          // so the picture never "closes" while the fresh link is prepared.
          // (Startups pass hasPresentedPlaybackFrame=false and behave as before.)
          preservePlaybackRecoveryState: this.hasPresentedPlaybackFrame === true,
          mountToken
        });
        return this.isActiveMountToken(mountToken);
      } catch (error) {
        console.warn("Stream URL recovery failed", { reason, error });
        return false;
      } finally {
        this.expiredStreamRecoveryInFlight = false;
      }
    },
    /**
     * Produce a playable candidate whose locator is not the expired one:
     * resolvable streams (debrid/P2P/media server) re-run their resolver
     * after their stale URL and resolve cache are dropped; plain addon links
     * need a force-refreshed stream list because only the addon can mint a
     * fresh signed URL.
     */
    async resolveFreshStreamCandidate(candidate, expiredUrl = "") {
      const resolveContext = {
        season: this.params?.season == null ? null : Number(this.params.season),
        episode: this.params?.episode == null ? null : Number(this.params.episode)
      };
      const resolvable =
        canResolveMediaServerStream(candidate) ||
        DirectDebridResolver.canResolveStream(candidate, resolveContext) ||
        WebOsEngineFsResolver.canResolveStream(candidate) ||
        TizenStreamingServerResolver.canResolveStream(candidate);
      if (resolvable) {
        // Drop the dead locator so playStreamCandidate re-runs resolution
        // instead of short-circuiting on the expired URL.
        if (/^https?:\/\//i.test(String(candidate.url || ""))) {
          candidate.url = "";
        }
        if (/^https?:\/\//i.test(String(candidate.externalUrl || ""))) {
          candidate.externalUrl = null;
        }
        invalidateResolvedStreamCache(candidate, resolveContext);
        return candidate;
      }
      const type = normalizeItemType(this.params?.itemType || "movie");
      const videoId = String(this.params?.videoId || this.params?.itemId || "");
      if (!videoId) {
        return null;
      }
      const result = await streamRepository.getStreamsFromAllAddons(type, videoId, {
        itemId: String(this.params?.itemId || ""),
        season: this.params?.season ?? null,
        episode: this.params?.episode ?? null,
        forceRefresh: true
      });
      const fresh = this.findEquivalentStreamCandidate(flattenStreamGroups(result), candidate, expiredUrl);
      if (!fresh) {
        return null;
      }
      const index = this.streamCandidates.findIndex(
        (entry) => entry === candidate || (entry.id && candidate.id && String(entry.id) === String(candidate.id))
      );
      if (index >= 0) {
        this.streamCandidates = this.streamCandidates.map((entry, i) => (i === index ? { ...entry, ...fresh } : entry));
        this.currentStreamIndex = index;
        return this.streamCandidates[index];
      }
      this.streamCandidates = [...this.streamCandidates, fresh];
      this.currentStreamIndex = this.streamCandidates.length - 1;
      return fresh;
    },
    findEquivalentStreamCandidate(items = [], previous = {}, expiredUrl = "") {
      if (!Array.isArray(items) || !items.length) {
        return null;
      }
      const expiredKey = String(expiredUrl || "").trim();
      const isDead = (item) => {
        const url = String(item?.url || item?.externalUrl || "").trim();
        return Boolean(expiredKey && url === expiredKey);
      };
      const prevId = String(previous.id || "").trim();
      if (prevId) {
        const byId = items.find((item) => String(item?.id || "").trim() === prevId && !isDead(item));
        if (byId) {
          return byId;
        }
      }
      const prevAddon = String(previous.addonName || "").trim();
      const prevLabel = String(previous.label || "").trim();
      const prevFilename = String(
        previous.behaviorHints?.filename || previous.raw?.behaviorHints?.filename || ""
      ).trim();
      if (prevAddon && (prevLabel || prevFilename)) {
        const byIdentity = items.find((item) => {
          if (isDead(item) || String(item?.addonName || "").trim() !== prevAddon) {
            return false;
          }
          const labelMatches = prevLabel ? String(item?.label || "").trim() === prevLabel : true;
          const filenameMatches = prevFilename
            ? String(item?.behaviorHints?.filename || item?.raw?.behaviorHints?.filename || "").trim() === prevFilename
            : true;
          return labelMatches && filenameMatches;
        });
        if (byIdentity) {
          return byIdentity;
        }
      }
      return null;
    },
    startStreamUrlRefreshTicker() {
      this.stopStreamUrlRefreshTicker();
      this.streamUrlRefreshTimer = setInterval(() => {
        void this.refreshExpiringStreamUrl();
      }, STREAM_URL_REFRESH_TICK_MS);
    },
    stopStreamUrlRefreshTicker() {
      if (this.streamUrlRefreshTimer) {
        clearInterval(this.streamUrlRefreshTimer);
        this.streamUrlRefreshTimer = null;
      }
    },
    /**
     * Proactive cut avoidance: while the active URL still has a detectable
     * TTL and less than the lead window left, re-resolve it and resume in
     * place. The5-minute tick means a link never reaches its expiry during
     * playback, so the cut never happens.
     */
    async refreshExpiringStreamUrl() {
      if (!this.playerRouteActive || !this.activePlaybackUrl || !this.hasPresentedPlaybackFrame || this.paused) {
        return;
      }
      if (this.expiredStreamRecoveryInFlight || this.streamUrlRefreshInFlight) {
        return;
      }
      const expiryMs = getStreamUrlExpiryTimestampMs(this.activePlaybackUrl);
      if (!expiryMs) {
        // No detectable TTL: the reactive recovery path covers this link if
        // it turns out to die mid-playback.
        return;
      }
      const remainingMs = expiryMs - Date.now();
      if (remainingMs > STREAM_URL_REFRESH_LEAD_MS || remainingMs <= 0) {
        // Still enough life for the next tick; already dead paths go through
        // the error handler, which recovers with the same helper.
        return;
      }
      this.streamUrlRefreshInFlight = true;
      try {
        const sourceCandidate = this.getStreamCandidateByUrl(this.activePlaybackUrl) || this.getCurrentStreamCandidate();
        const resumed = await this.recoverExpiredStreamPlayback({
          playbackUrl: this.activePlaybackUrl,
          sourceCandidate,
          reason: "stream-url-proactive-refresh",
          markFailed: false
        });
        console.warn("Proactive stream URL refresh", {
          remainingSeconds: Math.round(remainingMs / 1000),
          resumed
        });
      } finally {
        this.streamUrlRefreshInFlight = false;
      }
    },
    async playStreamCandidate(streamCandidate, options = {}) {
      const mountToken = options?.mountToken ?? null;
      if (!this.isActiveMountToken(mountToken)) {
        return;
      }
      if (!streamCandidate) {
        return;
      }
      streamRepository.setLocalPluginSearchPaused(true);
      const forceEngineFsResolve = options?.forceEngineFsResolve === true;
      let targetUrl = forceEngineFsResolve ? "" : streamDirectPlaybackUrl(streamCandidate);
      if (canResolveMediaServerStream(streamCandidate)) {
        const isCurrentRequest = () =>
          this.isActiveMountToken(mountToken) &&
          (!options.serverFallbackUrl ||
            (this.activePlaybackUrl === options.serverFallbackUrl && this.getCurrentStreamCandidate()?.id === streamCandidate.id));
        try {
          const result = await MediaServerRepository.resolve(streamCandidate, {
            allowDirectPlay: !options.serverFallbackUrl
          });
          if (!isCurrentRequest()) {
            if (result.status === "success" && options.serverFallbackUrl)
              void MediaServerRepository.report(result.stream.serverPlayback, "stop", 0, true).catch(() => {});
            return;
          }
          if (result.status !== "success" || !result.stream?.url) throw new Error("servers_playback_failed");
          Object.assign(streamCandidate, result.stream);
          targetUrl = result.stream.url;
          const saved = WatchProgressStore.listForProfile(result.stream.serverPlayback.profileId).find(
            (entry) =>
              entry.contentId === this.params?.itemId &&
              (entry.season ?? null) === (this.params?.season ?? null) &&
              (entry.episode ?? null) === (this.params?.episode ?? null)
          );
          const resume = newerServerResume(result.stream.serverUserState, saved, this.params?.startFromBeginning);
          if (resume && !options.preservePlaybackState) {
            this.pendingPlaybackRestore = { timeSeconds: resume.positionMs / 1000, paused: false, attempts: 0, lastAttemptAt: 0 };
            options = { ...options, preservePendingRestore: true };
          }
          this.streamCandidates = this.streamCandidates.map((entry) =>
            entry.id === streamCandidate.id ? { ...entry, ...streamCandidate } : entry
          );
        } catch (_) {
          if (isCurrentRequest()) this.showStartupError?.(t("servers_playback_failed", {}, "Could not start playback from the server."));
          return;
        }
      }
      if (!targetUrl) {
        const resolveContext = {
          season: this.params?.season == null ? null : Number(this.params.season),
          episode: this.params?.episode == null ? null : Number(this.params.episode)
        };
        const canUseEngineFs = WebOsEngineFsResolver.canResolveStream(streamCandidate);
        const canUseTizenP2p = TizenStreamingServerResolver.canResolveStream(streamCandidate);
        const canResolveP2p = canUseEngineFs || canUseTizenP2p;
        const tizenP2pUnsupported = TizenStreamingServerResolver.isUnsupportedOnCurrentTizen(streamCandidate);
        const p2pEnabled = Boolean(TorrentSettingsStore.get().p2pEnabled);
        const canUseP2p = p2pEnabled && canResolveP2p;
        let fallbackError = "";
        let resolveFailureStatus = "";
        let resolveFailureDetail = "";
        let preResolveEngineFsKeepAliveToken = "";
        const stopPreResolveEngineFsKeepAlive = () => {
          if (
            !preResolveEngineFsKeepAliveToken ||
            this.engineFsKeepAliveToken !== preResolveEngineFsKeepAliveToken ||
            this.currentEngineFsStream
          ) {
            return;
          }
          this.stopEngineFsKeepAlive();
        };

        if (DirectDebridResolver.canResolveStream(streamCandidate, resolveContext)) {
          const result = await DirectDebridResolver.resolve(streamCandidate, resolveContext);
          if (!this.isActiveMountToken(mountToken)) {
            return;
          }
          if (result.status === "success" && result.stream?.url) {
            targetUrl = result.stream.url;
            Object.assign(streamCandidate, {
              url: targetUrl,
              externalUrl: null,
              mimeType: result.stream.mimeType || streamCandidate.mimeType,
              sourceType: result.stream.sourceType || streamCandidate.sourceType,
              behaviorHints: result.stream.behaviorHints || streamCandidate.behaviorHints,
              raw: { ...(streamCandidate.raw || {}), ...(result.stream.raw || {}) }
            });
          } else {
            fallbackError =
              result.status === "service_degraded"
                ? t(
                    "stream.debrid.serviceDegraded",
                    {},
                    "The Debrid service is currently degraded. Try again later or choose another source."
                  )
                : result.status === "not_cached"
                  ? t("stream.debrid.notCached", {}, "Not cached on this service.")
                  : result.status === "stale"
                    ? t("stream.debrid.stale", {}, "This Debrid result expired. Refreshing streams.")
                    : t("stream.debrid.failed", {}, "Could not resolve this Debrid stream.");
            resolveFailureStatus = result.status || "debrid-failed";
            resolveFailureDetail = result.detail || result.error || "";
            if (result.status === "service_degraded") {
              if (!this.hasPresentedPlaybackFrame) {
                this.showStartupError(fallbackError, {
                  streamCandidate,
                  reason: "debrid-resolve",
                  resolverStatus: resolveFailureStatus,
                  resolverDetail: resolveFailureDetail
                });
              } else {
                this.sourcesError = this.formatPlaybackErrorForSources(fallbackError, {
                  streamCandidate,
                  reason: "debrid-resolve",
                  resolverStatus: resolveFailureStatus,
                  resolverDetail: resolveFailureDetail
                });
                this.renderSourcesPanel();
              }
              return;
            }
          }
        }

        if (!targetUrl && canUseP2p) {
          if (canUseEngineFs && !this.currentEngineFsStream && !this.engineFsKeepAliveToken) {
            const infoHash = getP2pInfoHash(streamCandidate);
            if (infoHash) {
              this.startEngineFsKeepAlive({
                kind: "webos-enginefs",
                infoHash,
                fileIdx: streamCandidate.fileIdx ?? streamCandidate.raw?.fileIdx ?? null
              });
              preResolveEngineFsKeepAliveToken = this.engineFsKeepAliveToken;
              logEngineFsDebug("EngineFS keepalive started before P2P resolve", {
                infoHash,
                fileIdx: streamCandidate.fileIdx ?? streamCandidate.raw?.fileIdx ?? null
              });
            }
          }
          const result = canUseEngineFs
            ? await WebOsEngineFsResolver.resolve(streamCandidate, resolveContext)
            : await TizenStreamingServerResolver.resolve(streamCandidate, resolveContext);
          if (!this.isActiveMountToken(mountToken)) {
            stopPreResolveEngineFsKeepAlive();
            const resolvedEngineFs = result?.stream?.engineFs || null;
            if (resolvedEngineFs?.infoHash) {
              void this.cleanupEngineFsState(resolvedEngineFs, "stale-p2p-resolve", {
                deferMs: 0
              }).catch(() => null);
            }
            return;
          }
          if (result.status === "success" && result.stream?.url) {
            targetUrl = result.stream.url;
            Object.assign(streamCandidate, {
              url: targetUrl,
              externalUrl: null,
              infoHash: result.stream.infoHash || streamCandidate.infoHash,
              fileIdx: result.stream.fileIdx ?? streamCandidate.fileIdx,
              engineFs: result.stream.engineFs || streamCandidate.engineFs || null,
              tizenP2p: result.stream.tizenP2p || streamCandidate.tizenP2p || null,
              mimeType: result.stream.mimeType || streamCandidate.mimeType,
              sourceType: result.stream.sourceType || streamCandidate.sourceType,
              behaviorHints: result.stream.behaviorHints || streamCandidate.behaviorHints,
              raw: { ...(streamCandidate.raw || {}), ...(result.stream.raw || {}) }
            });
          } else {
            resolveFailureStatus = result?.status || "p2p-failed";
            resolveFailureDetail = result?.detail || result?.error || "";
            console.warn("PlayerScreen: P2P resolve failed", {
              status: result.status,
              detail: result.detail || "",
              infoHash:
                streamCandidate.infoHash ||
                streamCandidate.raw?.infoHash ||
                streamCandidate.clientResolve?.infoHash ||
                streamCandidate.raw?.clientResolve?.infoHash ||
                "",
              fileIdx: streamCandidate.fileIdx ?? streamCandidate.raw?.fileIdx ?? null
            });

            stopPreResolveEngineFsKeepAlive();
          }
        }

        if (!targetUrl) {
          if (!this.isActiveMountToken(mountToken)) {
            return;
          }
          const startupMessage =
            fallbackError ||
            (tizenP2pUnsupported
              ? t("player_error_tizen_p2p_unsupported", {}, "Torrent/P2P streaming is not supported on this TV.")
              : !p2pEnabled && canResolveP2p
                ? t("player_error_p2p_disabled", {}, "P2P streaming is disabled. Enable P2P in Settings to play torrent streams.")
                : canUseP2p
                  ? t(
                      "player_error_failed_start_torrent",
                      [t("player_error_playback_fallback", {}, "Playback error")],
                      "Failed to start torrent: %1$s"
                    )
                  : t("player_error_playback_fallback", {}, "Playback error"));
          if (!this.hasPresentedPlaybackFrame) {
            this.showStartupError(startupMessage, {
              streamCandidate,
              reason: tizenP2pUnsupported
                ? "tizen-p2p-unsupported"
                : !p2pEnabled && canResolveP2p
                  ? "p2p-disabled"
                  : canUseP2p
                    ? "p2p-resolve"
                    : "stream-resolve",
              resolverStatus: resolveFailureStatus,
              resolverDetail: resolveFailureDetail
            });
            return;
          }
          const sourceErrorMessage = tizenP2pUnsupported
            ? t("player_error_tizen_p2p_unsupported", {}, "Torrent/P2P streaming is not supported on this TV.")
            : !p2pEnabled && canResolveP2p
              ? t("player_error_p2p_disabled", {}, "P2P streaming is disabled. Enable P2P in Settings to play torrent streams.")
              : canUseP2p
                ? t("stream.p2p.failed", {}, "Could not start this torrent stream.")
                : fallbackError || t("stream.debrid.unavailable", {}, "This Debrid source needs a configured Debrid account.");
          this.sourcesError = this.formatPlaybackErrorForSources(sourceErrorMessage, {
            streamCandidate,
            reason: tizenP2pUnsupported
              ? "tizen-p2p-unsupported"
              : !p2pEnabled && canResolveP2p
                ? "p2p-disabled"
                : canUseP2p
                  ? "p2p-resolve"
                  : "stream-resolve",
            resolverStatus: resolveFailureStatus,
            resolverDetail: resolveFailureDetail
          });
          this.renderSourcesPanel();
          return;
        }

        this.streamCandidates = this.streamCandidates.map((entry) =>
          entry.id === streamCandidate.id ? { ...entry, ...streamCandidate } : entry
        );
      }
      this.rememberSelectedStreamPreference(streamCandidate);
      await this.playStreamByUrl(targetUrl, {
        ...options,
        mountToken,
        sourceCandidate: streamCandidate
      });
    },
    async switchStream(direction) {
      if (!this.streamCandidates.length) {
        return;
      }

      this.currentStreamIndex += direction;
      if (this.currentStreamIndex >= this.streamCandidates.length) {
        this.currentStreamIndex = 0;
      }
      if (this.currentStreamIndex < 0) {
        this.currentStreamIndex = this.streamCandidates.length - 1;
      }

      const selected = this.streamCandidates[this.currentStreamIndex];
      if (!selected) {
        return;
      }
      await this.playStreamCandidate(selected, { preservePlaybackState: true });
    },
    markPlaybackSourceFailed(url = this.activePlaybackUrl, streamCandidate = this.getCurrentStreamCandidate()) {
      const normalizedUrl = String(url || "").trim();
      if (normalizedUrl) {
        (this.failedPlaybackUrls || (this.failedPlaybackUrls = new Set())).add(normalizedUrl);
      }
      const currentCandidate = streamCandidate || this.getCurrentStreamCandidate?.();
      const currentId = String(currentCandidate?.id || "").trim();
      if (currentId) {
        (this.failedPlaybackStreamIds || (this.failedPlaybackStreamIds = new Set())).add(currentId);
      }
    },
    mediaErrorMessage(errorCode = 0, detail = "", streamCandidate = this.getCurrentStreamCandidate()) {
      const code = Number(errorCode || 0);
      const text = String(detail || "").toLowerCase();
      const httpStatus = this.resolvePlaybackHttpStatus(detail);
      const httpMessage = this.getHttpPlaybackErrorMessage(httpStatus);
      if (httpMessage) {
        return httpMessage;
      }
      const compatibilityMessage = this.getWebHeaderRestrictedStreamMessage(streamCandidate);
      if (compatibilityMessage && (code === 0 || code === 2 || code === 4)) {
        return compatibilityMessage;
      }
      if (code === 1) return "Playback aborted";
      if (code === 2) return "Network error";
      if (code === 3) {
        const unsupported = t(
          "player_error_unsupported_format",
          [this.getPlaybackErrorCodeLabel(code) || "decode"],
          "This stream uses a format your device may not support. Try a different source. [%1$s]"
        );
        return `${t("player_error_decoder", {}, "Decoder error")}\n\n${unsupported}`;
      }
      if (code === 4) {
        if (this.isDebridPlaybackCandidate(streamCandidate)) {
          return t("player_error_stream_load_failed", {}, "Playback failed to load");
        }
        if (
          text.includes("manifestparsingerror") ||
          text.includes("manifest parsing") ||
          text.includes("unrecognized") ||
          text.includes("invalid content") ||
          text.includes("invalid data") ||
          text.includes("text/html") ||
          text.includes("html")
        ) {
          return t(
            "player_error_source_invalid_content",
            [this.getPlaybackErrorCodeLabel(code) || "source"],
            "Source error: The stream source returned invalid or unplayable content. The link may have expired or the server returned an error page instead of video.\n\nTry a different source. [%1$s]"
          );
        }
        if (
          text.includes("no supported source") ||
          text.includes("no supported sources") ||
          text.includes("not supported") ||
          text.includes("unsupported")
        ) {
          return t("player_error_source_not_supported", {}, "Source not supported on this TV");
        }
        return t("player_error_playback_fallback", {}, "Playback error");
      }
      return t("player_error_playback_fallback", {}, "Playback error");
    },
    attemptSilentAudioRecovery(reason = "silent-audio") {
      void reason;
      return false;
    },
    clearPlaybackStallGuard() {
      if (this.playbackStallTimer) {
        clearTimeout(this.playbackStallTimer);
        this.playbackStallTimer = null;
      }
    }
  };
}
