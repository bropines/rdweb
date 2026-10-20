// Saved servers, RustDesk config strings and WebSocket endpoint derivation.
import { announcedRelayUrl, parseServerKey, relayUrlNextTo, type ServerConfig } from "rdweb";

export interface ServerEntry {
  id: string;
  name: string;
  /** Host name ("rd.example.com") or the full hbbs WebSocket URL. */
  address: string;
  /** Optional hbbr WebSocket URL or host; derived from the address when empty. */
  relay?: string;
  /** hbbs public key (id_ed25519.pub). */
  key: string;
}

export interface RecentDevice {
  serverId: string;
  id: string;
  name?: string;
  at: number;
}

const SERVERS_KEY = "rdweb.app.servers";
const RECENT_KEY = "rdweb.app.recent";
const RECENT_MAX = 10;

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
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

export function loadServers(): ServerEntry[] {
  const list = read<ServerEntry[]>(SERVERS_KEY);
  return Array.isArray(list) ? list.filter((s) => s && typeof s.id === "string" && typeof s.address === "string" && typeof s.key === "string") : [];
}

export function saveServers(list: ServerEntry[]): void {
  write(SERVERS_KEY, list);
}

export function loadRecentDevices(): RecentDevice[] {
  const list = read<RecentDevice[]>(RECENT_KEY);
  return Array.isArray(list) ? list.filter((r) => r && typeof r.id === "string" && typeof r.serverId === "string").slice(0, RECENT_MAX) : [];
}

export function pushRecentDevice(serverId: string, id: string, name?: string): RecentDevice[] {
  const list = loadRecentDevices().filter((r) => !(r.serverId === serverId && r.id === id));
  list.unshift({ serverId, id, name, at: Date.now() });
  const out = list.slice(0, RECENT_MAX);
  write(RECENT_KEY, out);
  return out;
}

/** Removes everything the app itself stored (servers, recent devices, UI choices). */
export function clearAppData(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith("rdweb.app.")) localStorage.removeItem(k);
    }
  } catch {
    /* storage unavailable */
  }
}

export function newServerId(): string {
  return crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// RustDesk's own TCP ports (API, NAT test, ID, relay, WebSocket ID/relay):
// never the TLS reverse proxy that serves /ws/id and /ws/relay.
const RUSTDESK_PORTS = new Set(["21114", "21115", "21116", "21117", "21118", "21119"]);

/**
 * "rd.example.com", "https://rd.example.com/", "rd.example.com:21116" →
 * "rd.example.com" (RustDesk ports dropped, other ports kept).
 */
export function hostOf(input: string): string {
  let s = input.trim();
  if (!s) return "";
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`).host;
  } catch {
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    host = s.split(/[/?#]/)[0] ?? "";
  }
  const m = /^(.*):(\d+)$/.exec(host);
  if (m && RUSTDESK_PORTS.has(m[2]!)) host = m[1]!;
  return host.toLowerCase();
}

const isWsUrl = (s: string) => /^wss?:\/\//i.test(s.trim());

/** An IPv4 or IPv6 literal (with or without a port): browsers rarely get a valid certificate for one. */
export function isIpHost(host: string): boolean {
  const h = host.trim().replace(/^\[(.*)\](:\d+)?$/, "$1").replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, "$1");
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || (h.includes(":") && /^[0-9a-f:.]+$/i.test(h));
}

export interface Endpoints {
  rendezvousUrl: string;
  relayUrl: string;
}

/**
 * WebSocket endpoints of a server entry: a host name gets /ws/id and
 * /ws/relay over TLS; without a relay, hbbr is reached next to hbbs.
 */
export function endpoints(address: string, relay?: string): Endpoints {
  const a = address.trim();
  const r = relay?.trim() ?? "";
  const relayUrl = r ? (isWsUrl(r) ? r : `wss://${hostOf(r)}/ws/relay`) : "";
  if (isWsUrl(a)) return { rendezvousUrl: a, relayUrl: relayUrl || relayUrlNextTo(a) };
  const host = hostOf(a);
  return { rendezvousUrl: `wss://${host}/ws/id`, relayUrl: relayUrl || `wss://${host}/ws/relay` };
}

/**
 * RustDesk's public server (run by RustDesk, not by rdweb), used when no
 * server of one's own was added. Experimental in browsers: its ID server
 * serves WebSocket at /ws/id; relays are the ones it announces.
 */
export const PUBLIC_SERVER: ServerEntry = {
  id: "rustdesk-public",
  name: "RustDesk public server",
  address: "wss://rs-ny.rustdesk.com/ws/id",
  key: "OeVuKk5nlHiXp+APNn0Y3pC1Iwpwn44JGqrQCsWqmBw=",
};

export const isPublicServer = (s: Pick<ServerEntry, "id"> | null | undefined): boolean => s?.id === PUBLIC_SERVER.id;

const PUBLIC_OK_KEY = "rdweb.app.publicServerOk";

/** The user confirmed once that sessions may go through RustDesk's public server. */
export function publicServerConfirmed(): boolean {
  try {
    return localStorage.getItem(PUBLIC_OK_KEY) === "1";
  } catch {
    return false;
  }
}

export function confirmPublicServer(): void {
  try {
    localStorage.setItem(PUBLIC_OK_KEY, "1");
  } catch {
    /* storage unavailable: asked again next time */
  }
}

export function toServerConfig(s: ServerEntry): ServerConfig {
  // the public network assigns relays per session: reach the announced one
  if (isPublicServer(s)) return { rendezvousUrl: s.address, relayUrl: announcedRelayUrl, key: s.key };
  const e = endpoints(s.address, s.relay);
  return { rendezvousUrl: e.rendezvousUrl, relayUrl: () => e.relayUrl, key: s.key.trim() };
}

/** Null when the key is a valid Ed25519 public key in base64, else the problem. */
export function keyProblem(key: string): string | null {
  try {
    parseServerKey(key.trim());
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

export interface RustDeskConfig {
  host: string;
  relay: string;
  key: string;
  api: string;
}

function decodeJson(b64: string): unknown {
  let s = b64.replace(/-/g, "+").replace(/_/g, "/");
  s = s.replace(/=+$/, "");
  s += "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/**
 * Decodes the server config string the RustDesk client ("Export server
 * config") and RD Panel's Server page produce: URL-safe base64 of
 * {"host","relay","key","api"}, reversed. Also accepts the plain base64 and
 * JSON forms and a pasted `rustdesk --config "..."` command line.
 */
export function decodeConfigString(input: string): RustDeskConfig {
  let s = input.trim();
  const cli = /--config\s+["']?([^"'\s]+)/.exec(s);
  if (cli) s = cli[1]!;
  s = s.replace(/^["']|["']$/g, "").replace(/\s+/g, "");
  if (!s) throw new Error("empty");
  const attempts: (() => unknown)[] = [() => JSON.parse(s), () => decodeJson([...s].reverse().join("")), () => decodeJson(s)];
  for (const attempt of attempts) {
    let v: unknown;
    try {
      v = attempt();
    } catch {
      continue;
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string).trim() : "");
      const cfg = { host: str("host"), relay: str("relay"), key: str("key"), api: str("api") };
      if (cfg.host || cfg.key) return cfg;
    }
  }
  throw new Error("not a RustDesk server config string");
}

/**
 * Form values for a decoded config. Its host and relay are hbbs/hbbr TCP
 * addresses for native clients; an HTTPS API server is what a browser can
 * reach, and RD Panel serves /ws/id and /ws/relay there, so it wins.
 */
export function entryFromConfig(cfg: RustDeskConfig): Omit<ServerEntry, "id"> {
  const api = /^https:\/\//i.test(cfg.api) ? hostOf(cfg.api) : "";
  if (api && !isIpHost(api)) return { name: api, address: api, relay: undefined, key: cfg.key };
  const host = hostOf(cfg.host) || hostOf(cfg.api);
  const relayHost = hostOf(cfg.relay);
  return {
    name: host,
    address: host,
    relay: relayHost && relayHost !== host && !isIpHost(relayHost) ? relayHost : undefined,
    key: cfg.key,
  };
}

/** For "keyabc…xyz" displays. */
export function shortKey(key: string): string {
  const k = key.trim();
  return k.length > 14 ? `${k.slice(0, 6)}…${k.slice(-6)}` : k;
}
