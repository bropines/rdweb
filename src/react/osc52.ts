// OSC 52 in the terminal: a program on the device asks for text to be put in
// the clipboard ("ESC ] 52 ; c ; <base64> BEL"), as tmux and vim over SSH do.
// Opt in only. The limits are those of RustDesk's desktop terminal (1.5.0,
// rustdesk/rustdesk#16072): selection "c" or empty, strict base64 and UTF-8,
// at most 16 MiB of text. The query form ("?") asks the terminal for the
// clipboard so the program can read it: it is refused always, option or not,
// so nothing on the device can read what is on this computer.

/** The largest text a write may carry (RustDesk's ceiling), after decoding. */
export const OSC52_MAX_BYTES = 16 * 1024 * 1024;

/** The longest base64 payload that can hold OSC52_MAX_BYTES. */
const MAX_BASE64_CHARS = Math.ceil(OSC52_MAX_BYTES / 3) * 4;
const SELECTION = /^[cpqs0-7]*$/;
// padded base64; no repeated group, which overflows the regex stack on megabytes
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export type Osc52Result =
  | { kind: "write"; text: string }
  | { kind: "ignore"; reason: "disabled" | "query" | "malformed" | "selection" | "empty" | "too-large" | "bad-base64" | "bad-utf8" };

/**
 * Decides what an OSC 52 payload (the part after "52;", e.g. "c;SGVsbG8=")
 * means. Pure: does not touch the clipboard.
 */
export function parseOsc52(data: string, enabled: boolean): Osc52Result {
  const parts = data.split(";");
  if (parts.length !== 2 || !SELECTION.test(parts[0]!)) return { kind: "ignore", reason: "malformed" };
  const [selection, payload] = parts as [string, string];
  // a query is refused whatever the option says
  if (payload === "?") return { kind: "ignore", reason: "query" };
  if (!enabled) return { kind: "ignore", reason: "disabled" };
  // only the system clipboard exists here; "c" among others is still it
  if (selection !== "" && !selection.includes("c")) return { kind: "ignore", reason: "selection" };
  if (payload.length > MAX_BASE64_CHARS) return { kind: "ignore", reason: "too-large" };
  // an empty payload would clear the clipboard: not something a program gets to do
  if (payload === "") return { kind: "ignore", reason: "empty" };
  if (payload.length % 4 !== 0 || !BASE64.test(payload)) return { kind: "ignore", reason: "bad-base64" };
  let bytes: Uint8Array;
  try {
    const bin = atob(payload);
    bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return { kind: "ignore", reason: "bad-base64" };
  }
  if (bytes.length > OSC52_MAX_BYTES) return { kind: "ignore", reason: "too-large" };
  try {
    return { kind: "write", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { kind: "ignore", reason: "bad-utf8" };
  }
}

/**
 * The handler for xterm's `parser.registerOscHandler(52, …)`. `isEnabled` is
 * read on every sequence, so the option takes effect at once. Always returns
 * true (the sequence is consumed, never printed); a missing clipboard API or a
 * rejected write (no permission, page not focused) is dropped quietly.
 */
export function osc52Handler(isEnabled: () => boolean, write?: (text: string) => Promise<void>): (data: string) => boolean {
  return (data) => {
    const r = parseOsc52(data, isEnabled());
    if (r.kind !== "write") return true;
    try {
      const w = write ?? (typeof navigator !== "undefined" && navigator.clipboard ? (t: string) => navigator.clipboard.writeText(t) : undefined);
      void Promise.resolve(w?.(r.text)).catch(() => {});
    } catch {
      /* no clipboard here */
    }
    return true;
  };
}
