// Where a device's terminal sessions (the peer's persistent shell services) are
// remembered so they can be reattached later, from this or another browser.

/** A set of shells kept running on a device (RustDesk terminal service). */
export interface SavedShells {
  /** The device's service id; whoever has it (and can sign in) gets the shells back. */
  serviceId: string;
  hostname?: string;
  /** Open tabs when last seen. */
  tabs: number;
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
