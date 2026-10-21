/** Extra keys for on-screen keyboards: layouts and what each key sends. */

/** One key of the extra keys bar. */
export interface KeyDef {
  /** What the key sends: an id from {@link TERMINAL_KEYS} / {@link DESKTOP_KEYS}, a modifier, or a literal character. */
  id: string;
  /** Shown on the key; defaults to the id. */
  label?: string;
  /** Sent instead when the key is swiped up (like Termux). */
  popup?: string;
  /** Repeats while held. */
  repeat?: boolean;
}

/** The pinned key that shows and hides the extra layers. */
export const MORE = "more";
export const MODIFIERS = ["ctrl", "alt", "shift", "meta"] as const;
export type Modifier = (typeof MODIFIERS)[number];
export const isModifier = (id: string): id is Modifier => (MODIFIERS as readonly string[]).includes(id);

const k = (id: string, label?: string, more: Partial<KeyDef> = {}): KeyDef => ({ id, label, ...more });
const arrow = (id: string, label: string): KeyDef => ({ id, label, repeat: true });
const fkeys = (from: number, to: number): KeyDef[] => Array.from({ length: to - from + 1 }, (_, i) => k(`f${from + i}`, `F${from + i}`));

/** Terminal: Termux's default two rows plus the pinned ▲; layers above with F-keys, control keys and symbols. */
export const TERMINAL_LAYOUT: { base: KeyDef[][]; more: KeyDef[][] } = {
  base: [
    [k("esc", "Esc"), k("/", "/", { popup: "\\" }), k("-", "-", { popup: "|" }), k("home", "Home"), arrow("up", "↑"), k("end", "End"), k("pgup", "PgUp"), k(MORE)],
    [k("tab", "Tab"), k("ctrl", "Ctrl"), k("alt", "Alt"), arrow("left", "←"), arrow("down", "↓"), arrow("right", "→"), k("pgdn", "PgDn"), k("shift", "Shift")],
  ],
  more: [
    fkeys(1, 6),
    fkeys(7, 12),
    [k("^c", "^C"), k("^d", "^D"), k("^z", "^Z"), k("^l", "^L"), k("^r", "^R"), k("ins", "Ins"), k("del", "Del"), k("paste", "Paste")],
    ["|", "~", "`", "\\", "{", "}", "[", "]", "<", ">"].map((c) => k(c)),
  ],
};

/** Remote desktop: the same shape, with Win and the keys a PC keyboard has. */
export const DESKTOP_LAYOUT: { base: KeyDef[][]; more: KeyDef[][] } = {
  base: [
    [k("esc", "Esc"), k("tab", "Tab"), k("del", "Del"), k("home", "Home"), arrow("up", "↑"), k("end", "End"), k("pgup", "PgUp"), k(MORE)],
    [k("ctrl", "Ctrl"), k("alt", "Alt"), k("meta", "Win"), arrow("left", "←"), arrow("down", "↓"), arrow("right", "→"), k("pgdn", "PgDn"), k("shift", "Shift")],
  ],
  more: [fkeys(1, 6), fkeys(7, 12), [k("ins", "Ins"), k("prtsc", "PrtSc"), k("menu", "Menu"), k("backspace", "⌫", { repeat: true }), k("enter", "Enter")]],
};

/** The desktop layout with the Windows key named for the remote system. */
export function desktopLayout(os?: string): typeof DESKTOP_LAYOUT {
  const meta = os === "macos" ? "Cmd" : os === "linux" ? "Super" : "Win";
  const relabel = (rows: KeyDef[][]) => rows.map((row) => row.map((d) => (d.id === "meta" ? { ...d, label: meta } : d)));
  return { base: relabel(DESKTOP_LAYOUT.base), more: DESKTOP_LAYOUT.more };
}

// ------------------------------------------------------------------ terminal

export interface TermMods {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

const CSI = "\x1b[";
const CURSOR: Record<string, string> = { up: "A", down: "B", right: "C", left: "D", home: "H", end: "F" };
const TILDE: Record<string, number> = { ins: 2, del: 3, pgup: 5, pgdn: 6, f5: 15, f6: 17, f7: 18, f8: 19, f9: 20, f10: 21, f11: 23, f12: 24 };
const SS3_F: Record<string, string> = { f1: "P", f2: "Q", f3: "R", f4: "S" };
const CONTROL: Record<string, string> = { "^c": "\x03", "^d": "\x04", "^z": "\x1a", "^l": "\x0c", "^r": "\x12" };

/**
 * The bytes an xterm-compatible terminal sends for a key with modifiers
 * (modifier parameter 1 + shift + 2·alt + 4·ctrl). appCursor: the
 * application cursor keys mode (DECCKM) that full-screen programs turn on.
 * null for ids that are not keys (modifiers, "paste", MORE).
 */
export function terminalKey(id: string, m: TermMods, appCursor = false): string | null {
  const mod = 1 + (m.shift ? 1 : 0) + (m.alt ? 2 : 0) + (m.ctrl ? 4 : 0);
  const cur = CURSOR[id];
  if (cur) return mod > 1 ? `${CSI}1;${mod}${cur}` : `${appCursor ? "\x1bO" : CSI}${cur}`;
  const f = SS3_F[id];
  if (f) return mod > 1 ? `${CSI}1;${mod}${f}` : `\x1bO${f}`;
  const n = TILDE[id];
  if (n !== undefined) return mod > 1 ? `${CSI}${n};${mod}~` : `${CSI}${n}~`;
  const alt = (s: string) => (m.alt ? `\x1b${s}` : s);
  if (id === "esc") return alt("\x1b");
  if (id === "tab") return m.shift ? `${CSI}Z` : alt("\t");
  if (CONTROL[id]) return alt(CONTROL[id]);
  if ([...id].length === 1) return modifyText(id, m);
  return null;
}

/**
 * Applies latched modifiers to text typed on the on-screen keyboard: Ctrl
 * makes control characters, Alt prefixes ESC, Shift upper-cases a letter
 * and turns Enter into a newline for CLIs (ESC CR, as Shift+Enter does).
 * Text longer than one character is sent unchanged.
 */
export function modifyText(d: string, m: TermMods): string {
  if ((!m.ctrl && !m.alt && !m.shift) || [...d].length !== 1) return d;
  let out = d;
  if (m.shift) {
    if (d === "\r") return "\x1b\r";
    out = out.toUpperCase();
  }
  if (m.ctrl) {
    const c = latinFor(out).toUpperCase().charCodeAt(0);
    if (c >= 0x40 && c <= 0x5f) out = String.fromCharCode(c & 0x1f); // Ctrl+A..Z, [ \\ ] ^ _
    else if (out === " ") out = "\x00";
    else if (out === "?") out = "\x7f";
  }
  if (m.alt) out = `\x1b${out}`;
  return out;
}

// ------------------------------------------------------------------- desktop

/** KeyboardEvent code/key for the desktop keys. */
export const DESKTOP_KEYS: Record<string, { code: string; key: string }> = {
  esc: { code: "Escape", key: "Escape" },
  tab: { code: "Tab", key: "Tab" },
  del: { code: "Delete", key: "Delete" },
  ins: { code: "Insert", key: "Insert" },
  home: { code: "Home", key: "Home" },
  end: { code: "End", key: "End" },
  pgup: { code: "PageUp", key: "PageUp" },
  pgdn: { code: "PageDown", key: "PageDown" },
  up: { code: "ArrowUp", key: "ArrowUp" },
  down: { code: "ArrowDown", key: "ArrowDown" },
  left: { code: "ArrowLeft", key: "ArrowLeft" },
  right: { code: "ArrowRight", key: "ArrowRight" },
  prtsc: { code: "PrintScreen", key: "PrintScreen" },
  menu: { code: "ContextMenu", key: "ContextMenu" },
  backspace: { code: "Backspace", key: "Backspace" },
  enter: { code: "Enter", key: "Enter" },
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, { code: `F${i + 1}`, key: `F${i + 1}` }])),
};

export const MODIFIER_CODES: Record<Modifier, string> = { ctrl: "ControlLeft", alt: "AltLeft", shift: "ShiftLeft", meta: "MetaLeft" };

// ЙЦУКЕН letters on the keys of the Latin QWERTY ones (Ctrl+С is Ctrl+C)
const RU = "йцукенгшщзхъфывапролджэячсмитьбю";
const RU_LATIN = "qwertyuiop[]asdfghjkl;'zxcvbnm,.";
const latinFor = (ch: string): string => {
  const i = RU.indexOf(ch.toLowerCase());
  return i >= 0 ? RU_LATIN[i]! : ch;
};

const PUNCT: Record<string, string> = {
  "-": "Minus",
  "=": "Equal",
  "[": "BracketLeft",
  "]": "BracketRight",
  ";": "Semicolon",
  "'": "Quote",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  "\\": "Backslash",
  "`": "Backquote",
  " ": "Space",
};

/**
 * The physical key for a character typed on an on-screen keyboard, so a
 * latched Ctrl/Alt/Win can be pressed with it (Ctrl+C rather than a "c").
 * null when there is no such key on a US layout.
 */
export function physicalKey(ch: string): { code: string; key: string } | null {
  if ([...ch].length !== 1) return null;
  const c = latinFor(ch).toLowerCase();
  if (c >= "a" && c <= "z") return { code: `Key${c.toUpperCase()}`, key: c };
  if (c >= "0" && c <= "9") return { code: `Digit${c}`, key: c };
  if (PUNCT[c]) return { code: PUNCT[c], key: c };
  if (ch === "\n" || ch === "\r") return { code: "Enter", key: "Enter" };
  return null;
}
