import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, ChevronUp, Delete, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { isModifier, MORE, type KeyDef } from "./keys.js";
import { cn } from "./lib/utils.js";

const REPEAT_DELAY_MS = 400;
const REPEAT_EVERY_MS = 60;
/** How far up a finger moves for a key's swipe-up character. */
const SWIPE_UP_PX = 18;
/** Labels drawn as icons: arrow glyphs are tiny in most monospace fonts. */
const ICONS: Record<string, LucideIcon> = { "↑": ArrowUp, "↓": ArrowDown, "←": ArrowLeft, "→": ArrowRight, "⌫": Delete };

export interface ExtraKeysProps {
  /** Rows always shown, Termux style: each row splits the width evenly. */
  base: KeyDef[][];
  /** Layers shown above the base rows while the pinned ▲ key is on. */
  more: KeyDef[][];
  /** Latched modifiers, shown pressed. */
  latched: ReadonlySet<string>;
  /** A key (or its swipe-up character) was pressed; modifiers toggle. */
  onKey: (id: string) => void;
  label: string;
  moreLabel: string;
  lessLabel: string;
  /** Accessible names for keys drawn as icons (arrows, backspace), by id. */
  names?: Record<string, string>;
  className?: string;
}

/**
 * The extra keys bar for on-screen keyboards. Keys fire on release (a swipe
 * up sends the key's second character), arrows on press and again while
 * held. The bar never takes the focus, so the keyboard stays open, and does
 * not let a long press select text.
 */
export function ExtraKeys(props: ExtraKeysProps) {
  const [expanded, setExpanded] = useState(false);
  const [pressed, setPressed] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const press = useRef<{ id: string; y: number; pointer: number } | null>(null);
  const onKeyRef = useRef(props.onKey);
  onKeyRef.current = props.onKey;

  const stopRepeat = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      clearInterval(timer.current);
      timer.current = null;
    }
  };
  useEffect(() => stopRepeat, []);

  // A non-passive touchstart is the only way to stop Android's long-press
  // text selection and keep the focus (and keyboard) where it is.
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const block = (e: TouchEvent) => e.preventDefault();
    el.addEventListener("touchstart", block, { passive: false });
    return () => el.removeEventListener("touchstart", block);
  }, []);

  const down = (e: ReactPointerEvent<HTMLButtonElement>, def: KeyDef) => {
    e.preventDefault();
    stopRepeat();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events */
    }
    press.current = { id: def.id, y: e.clientY, pointer: e.pointerId };
    setPressed(def.id);
    if (def.repeat) {
      onKeyRef.current(def.id);
      timer.current = setTimeout(() => {
        timer.current = setInterval(() => onKeyRef.current(def.id), REPEAT_EVERY_MS);
      }, REPEAT_DELAY_MS);
    }
  };

  const up = (e: ReactPointerEvent<HTMLButtonElement>, def: KeyDef) => {
    const p = press.current;
    press.current = null;
    setPressed(null);
    stopRepeat();
    if (!p || p.id !== def.id || p.pointer !== e.pointerId || def.repeat) return;
    if (def.id === MORE) {
      setExpanded((x) => !x);
      return;
    }
    onKeyRef.current(def.popup && p.y - e.clientY >= SWIPE_UP_PX ? def.popup : def.id);
  };

  const cancel = () => {
    press.current = null;
    setPressed(null);
    stopRepeat();
  };

  const rows = expanded ? [...props.more, ...props.base] : props.base;
  return (
    <div
      ref={barRef}
      role="toolbar"
      aria-label={props.label}
      className={cn("shrink-0 touch-none select-none border-t border-white/10 bg-neutral-950 px-1 py-1 [-webkit-touch-callout:none]", props.className)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {rows.map((row, r) => (
        <div key={r} className={cn("flex", r === props.more.length - 1 && expanded && "mb-1 border-b border-white/10 pb-1")}>
          {row.map((def) => {
            const more = def.id === MORE;
            const on = more ? expanded : props.latched.has(def.id);
            const text = def.label ?? def.id;
            const Icon = more ? (expanded ? ChevronDown : ChevronUp) : ICONS[text];
            const label = more ? (expanded ? props.lessLabel : props.moreLabel) : Icon ? (props.names?.[def.id] ?? text) : undefined;
            return (
              <button
                key={def.id}
                type="button"
                tabIndex={-1}
                aria-label={label}
                title={label}
                aria-pressed={more || isModifier(def.id) ? on : undefined}
                className={cn(
                  "relative flex h-11 min-w-0 flex-1 items-center justify-center rounded-md font-mono text-white outline-none",
                  [...text].length === 1 ? "text-lg" : "text-[13px]",
                  pressed === def.id ? "bg-white/25" : on ? (more ? "bg-white/15" : "bg-blue-600") : "active:bg-white/15",
                )}
                onMouseDown={(e) => e.preventDefault()}
                onPointerDown={(e) => down(e, def)}
                onPointerUp={(e) => up(e, def)}
                onPointerCancel={cancel}
              >
                {Icon ? <Icon className="h-5 w-5" /> : text}
                {def.popup && <span aria-hidden className="pointer-events-none absolute right-1 top-0.5 text-[9px] leading-none text-white/45">{def.popup}</span>}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
