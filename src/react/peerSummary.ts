import type { PeerOs, PeerSummary } from "../index.js";

/**
 * A PeerSummary for the connections without a screen (Files only,
 * Terminal): who the device is; the display, codec and session lists are
 * empty.
 */
export function screenlessPeer(peer: { id: string; username: string; hostname: string; platform: string; os: PeerOs; version: string }): PeerSummary {
  return {
    id: peer.id,
    username: peer.username,
    hostname: peer.hostname,
    platform: peer.platform,
    os: peer.os,
    version: peer.version,
    displays: [],
    currentDisplay: 0,
    resolutions: [],
    codecs: [],
    codecs444: [],
    privacyModeSupported: false,
    sasEnabled: false,
    windowsSessions: [],
    currentWindowsSession: 0,
  };
}
