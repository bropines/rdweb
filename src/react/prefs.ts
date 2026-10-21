// Per-browser preferences, remembered device passwords and recent devices.
//
// Everything lives in localStorage under one prefix (the `storageKey`):
//   <prefix>.prefs                          settings, view and toolbar prefs
//   <prefix>.pw.<server key[0:16]>.<peer>   remembered password hash
//   <prefix>.recent                         recently connected devices
//   <prefix>.device.<server key[0:16]>.<peer>  this device's settings that
//                                           differ from the defaults (prefs)
//   <prefix>.files.localPane                file manager: local pane shown
// (and the file manager's local folder handle in IndexedDB, see localFolder.ts)
// RD Panel's web client used exactly this layout with the prefix
// "rdpanel.webclient", so passing that prefix keeps its users' data.
import { DEFAULT_SETTINGS, decodeBase64, encodeBase64, type InputMode, type ScaleMode, type SessionSettings } from "../index.js";
import { clearLocalFolderData } from "./localFolder.js";

export const DEFAULT_STORAGE_KEY = "rdweb";
/** The prefix RD Panel used before the UI moved into rdweb. */
export const RDPANEL_STORAGE_KEY = "rdpanel.webclient";

export interface ViewPrefs {
  scaleMode: ScaleMode;
  /** null = pick by device (touch screens: trackpad) */
  inputMode: InputMode | null;
  zoomCursor: boolean;
  showStats: boolean;
}

export interface ToolbarPrefs {
  /** Pinned quick actions (null = defaults for the device). */
  pinned: string[] | null;
  /** Keep the floating bar open instead of collapsing it. */
  keepOpen: boolean;
  /** Horizontal centre of the bar, 0..1. */
  position: number;
}

export interface WebClientPrefs {
  settings: SessionSettings;
  view: ViewPrefs;
  toolbar: ToolbarPrefs;
}

export const DEFAULT_TOOLBAR: ToolbarPrefs = { pinned: null, keepOpen: false, position: 0.5 };
export const DEFAULT_VIEW: ViewPrefs = { scaleMode: "fit", inputMode: null, zoomCursor: false, showStats: false };

const keys = (prefix: string) => ({
  prefs: `${prefix}.prefs`,
  pw: `${prefix}.pw.`,
  recent: `${prefix}.recent`,
  device: `${prefix}.device.`,
});

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

function removeWhere(match: (key: string) => boolean): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && match(k)) localStorage.removeItem(k);
    }
  } catch {
    /* storage unavailable */
  }
}

export function loadPrefs(storageKey: string = DEFAULT_STORAGE_KEY): WebClientPrefs {
  const p = read<Partial<WebClientPrefs>>(keys(storageKey).prefs);
  return {
    // view-only is a per-session choice, never restored
    settings: { ...DEFAULT_SETTINGS, ...(p?.settings ?? {}), viewOnly: false },
    view: { ...DEFAULT_VIEW, ...(p?.view ?? {}) },
    toolbar: { ...DEFAULT_TOOLBAR, ...(p?.toolbar ?? {}) },
  };
}

export function savePrefs(p: WebClientPrefs, storageKey: string = DEFAULT_STORAGE_KEY): void {
  write(keys(storageKey).prefs, p);
}

/**
 * Remembered passwords are stored like the desktop client does: the salted
 * hash SHA256(password || salt), bound to the server key and device id. It
 * logs in to that device but does not reveal the password.
 */
function pwKey(storageKey: string, serverKey: string, peerId: string): string {
  return `${keys(storageKey).pw}${serverKey.slice(0, 16)}.${peerId}`;
}

export function loadRememberedHash(serverKey: string, peerId: string, storageKey: string = DEFAULT_STORAGE_KEY): Uint8Array | undefined {
  const v = read<string>(pwKey(storageKey, serverKey, peerId));
  if (!v) return undefined;
  try {
    return decodeBase64(v);
  } catch {
    return undefined;
  }
}

export function saveRememberedHash(serverKey: string, peerId: string, hash: Uint8Array | null, storageKey: string = DEFAULT_STORAGE_KEY): void {
  write(pwKey(storageKey, serverKey, peerId), hash ? encodeBase64(hash) : null);
}

export function hasRememberedHash(serverKey: string, peerId: string, storageKey: string = DEFAULT_STORAGE_KEY): boolean {
  return read<string>(pwKey(storageKey, serverKey, peerId)) !== null;
}

/**
 * Connection settings kept per device (like the desktop client's per-peer
 * settings): what a session changes is remembered for that device, the
 * prefs hold the defaults. Only the differences from the defaults are
 * stored, so later changes to the defaults still reach every device that
 * did not override them. View only is a per-session choice and never kept.
 */
export interface DevicePrefs {
  settings?: Partial<SessionSettings>;
  scaleMode?: ScaleMode;
}

/** The settings a device can override. */
export const DEVICE_SETTING_KEYS = [
  "imageQuality",
  "customQuality",
  "customFps",
  "codec",
  "trueColor",
  "showRemoteCursor",
  "followRemoteCursor",
  "followRemoteWindow",
  "disableAudio",
  "disableClipboard",
  "lockAfterSessionEnd",
  "showMyCursor",
  "keyboardMode",
  "swapCtrlMeta",
] as const satisfies readonly (keyof SessionSettings)[];

function deviceKey(storageKey: string, serverKey: string, peerId: string): string {
  return `${keys(storageKey).device}${serverKey.slice(0, 16)}.${peerId}`;
}

export function loadDevicePrefs(serverKey: string, peerId: string, storageKey: string = DEFAULT_STORAGE_KEY): DevicePrefs {
  const v = read<DevicePrefs>(deviceKey(storageKey, serverKey, peerId));
  if (!v || typeof v !== "object") return {};
  const settings: Partial<SessionSettings> = {};
  for (const k of DEVICE_SETTING_KEYS) {
    const x = v.settings?.[k];
    if (x !== undefined && typeof x === typeof DEFAULT_SETTINGS[k]) (settings as Record<string, unknown>)[k] = x;
  }
  const scaleMode = v.scaleMode === "fit" || v.scaleMode === "original" || v.scaleMode === "stretch" ? v.scaleMode : undefined;
  return { ...(Object.keys(settings).length ? { settings } : {}), ...(scaleMode ? { scaleMode } : {}) };
}

/** Stores a device's overrides; an empty one (or null) forgets them. */
export function saveDevicePrefs(serverKey: string, peerId: string, d: DevicePrefs | null, storageKey: string = DEFAULT_STORAGE_KEY): void {
  const empty = !d || (!d.scaleMode && !Object.keys(d.settings ?? {}).length);
  write(deviceKey(storageKey, serverKey, peerId), empty ? null : d);
}

/** The defaults with a device's overrides applied. */
export function withDevicePrefs(defaults: WebClientPrefs, d: DevicePrefs): WebClientPrefs {
  return {
    ...defaults,
    settings: { ...defaults.settings, ...(d.settings ?? {}), viewOnly: defaults.settings.viewOnly },
    view: { ...defaults.view, ...(d.scaleMode ? { scaleMode: d.scaleMode } : {}) },
  };
}

/** What a session's prefs change from the defaults, as a device's overrides. */
export function devicePrefsOf(defaults: WebClientPrefs, current: WebClientPrefs): DevicePrefs {
  const settings: Partial<SessionSettings> = {};
  for (const k of DEVICE_SETTING_KEYS) {
    if (current.settings[k] !== defaults.settings[k]) (settings as Record<string, unknown>)[k] = current.settings[k];
  }
  const scaleMode = current.view.scaleMode !== defaults.view.scaleMode ? current.view.scaleMode : undefined;
  return { ...(Object.keys(settings).length ? { settings } : {}), ...(scaleMode ? { scaleMode } : {}) };
}

export interface RecentPeer {
  id: string;
  name?: string;
  at: number;
}

const RECENT_MAX = 8;

export function loadRecent(storageKey: string = DEFAULT_STORAGE_KEY): RecentPeer[] {
  const r = read<RecentPeer[]>(keys(storageKey).recent);
  return Array.isArray(r) ? r.filter((x) => typeof x?.id === "string").slice(0, RECENT_MAX) : [];
}

export function pushRecent(id: string, name?: string, storageKey: string = DEFAULT_STORAGE_KEY): void {
  const list = loadRecent(storageKey).filter((r) => r.id !== id);
  list.unshift({ id, name, at: Date.now() });
  write(keys(storageKey).recent, list.slice(0, RECENT_MAX));
}

/** Plaintext passwords stored by RD Panel's first web client version. */
function isRdpanelLegacyKey(k: string): boolean {
  return k.startsWith("rdpanel_pwd_") || k === "rdpanel_webclient_server_settings";
}

/**
 * Brings stored data up to date. With RD Panel's prefix the panel's existing
 * prefs, remembered hashes and recent devices are read as they are (same
 * keys); the plaintext passwords of its first web client are removed, as the
 * panel did on every visit.
 */
export function migrateStorage(storageKey: string = DEFAULT_STORAGE_KEY): void {
  if (storageKey === RDPANEL_STORAGE_KEY) removeWhere(isRdpanelLegacyKey);
}

/** Forgets everything stored under this prefix in this browser. */
export function clearStoredData(storageKey: string = DEFAULT_STORAGE_KEY): void {
  const k = keys(storageKey);
  removeWhere(
    (key) =>
      key.startsWith(k.pw) ||
      key.startsWith(k.device) ||
      key === k.recent ||
      key === k.prefs ||
      key === `${storageKey}.keys` || // the extra keys bar: layers open or hidden
      // terminal settings and remembered shells (<key>.terminal, <key>.terminal.shells.*)
      key === `${storageKey}.terminal` ||
      key.startsWith(`${storageKey}.terminal.`) ||
      (storageKey === RDPANEL_STORAGE_KEY && isRdpanelLegacyKey(key)),
  );
  // this tab's reattach ids (<key>.terminal.service.*)
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(`${storageKey}.terminal.`)) sessionStorage.removeItem(key);
    }
  } catch {
    /* storage unavailable */
  }
  clearLocalFolderData(storageKey);
}
