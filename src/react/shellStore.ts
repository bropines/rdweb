// Where a device's terminal sessions (the peer's persistent shell services) are
// remembered so they can be reattached later, from this or another browser.

import type { CloseInfo } from "../types.js";

/** A set of shells kept running on a device (RustDesk terminal service). */
export interface SavedShells {
  /** The device's service id; whoever has it (and can sign in) gets the shells back. */
  serviceId: string;
  hostname?: string;
  /** Open tabs when last seen. */
  tabs: number;
  /**
   * Opened with an administrator login, so the shells run under the device's
   * own account. Reattaching needs those credentials again; the password is
   * never stored, only the user name, and a store that cannot keep these two
   * fields simply loses the hint (the device then refuses the mismatch).
   */
  admin?: boolean;
  adminUser?: string;
  /** Milliseconds since the epoch. */
  createdAt: number;
  updatedAt: number;
}

/** Remembered terminal sessions of one device. Hosts with accounts can keep them server side. */
export interface ShellStore {
  list(): Promise<SavedShells[]>;
  save(shells: SavedShells): Promise<void>;
  remove(serviceId: string): Promise<void>;
}

const MAX_SAVED = 10;

/**
 * What a closed terminal session means for the shells the device may still be
 * keeping: reattach to them, forget them, or keep the record and ask the user
 * next time.
 *
 * `info.remote` deliberately plays no part. A relay timing out an idle session
 * and a laptop going to sleep close the socket exactly as the peer does, so it
 * cannot tell a dead service from a lost connection — and forgetting a service
 * that is still running strands its shells for good, because nothing in the
 * protocol lists a device's services: the id is the only way back. A record
 * kept for shells that did end costs one click in the chooser, and is dropped
 * as soon as the device answers with a service id of its own.
 */
export function closeAction(info: CloseInfo, opts: { persistent: boolean; shellsEnded: boolean }): "retry" | "forget" | "keep" {
  if (!opts.persistent) return "forget";
  if (info.retryable) return "retry";
  return opts.shellsEnded ? "forget" : "keep";
}

/** This browser's localStorage, per server key and device. */
export function localShellStore(storageKey: string, serverKey: string, peerId: string): ShellStore {
  const key = `${storageKey}.terminal.shells.${serverKey.trim()}.${peerId}`;
  const read = (): SavedShells[] => {
    try {
      const v = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
      return Array.isArray(v) ? (v as SavedShells[]).filter((x) => x && typeof x.serviceId === "string" && x.serviceId) : [];
    } catch {
      return [];
    }
  };
  const write = (list: SavedShells[]) => {
    try {
      if (list.length) localStorage.setItem(key, JSON.stringify(list));
      else localStorage.removeItem(key);
    } catch {
      /* storage unavailable */
    }
  };
  return {
    list: async () => read().sort((a, b) => b.updatedAt - a.updatedAt),
    save: async (s) => {
      const rest = read().filter((x) => x.serviceId !== s.serviceId);
      write([s, ...rest].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SAVED));
    },
    remove: async (id) => write(read().filter((x) => x.serviceId !== id)),
  };
}
