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
  /** Title of the pinned key and of the button that brings the hidden bar back. */
  hideHint?: string;
  showLabel?: string;
  /** localStorage key for whether the layers are open or the bar hidden. */
  stateKey?: string;
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
type BarState = "base" | "more" | "hidden";

function loadState(key?: string): BarState {
  try {
    const v = key ? localStorage.getItem(key) : null;
    return v === "more" || v === "hidden" ? v : "base";
  } catch {
    return "base";
  }
}

export function ExtraKeys(props: ExtraKeysProps) {
  const [state, setStateRaw] = useState<BarState>(() => loadState(props.stateKey));
  const setState = (next: BarState) => {
    setStateRaw(next);
    try {
      if (props.stateKey) localStorage.setItem(props.stateKey, next);
    } catch {
      /* storage unavailable */
    }
  };
  const expanded = state === "more";
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
  }, [state]);

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
      // tap: the layers on/off; swipe down: hide the whole bar
      setState(e.clientY - p.y >= SWIPE_UP_PX ? "hidden" : expanded ? "base" : "more");
      return;
    }
    onKeyRef.current(def.popup && p.y - e.clientY >= SWIPE_UP_PX ? def.popup : def.id);
  };

  const cancel = () => {
    press.current = null;
    setPressed(null);
    stopRepeat();
  };

  if (state === "hidden") {
    return (
      <div className="relative h-0 shrink-0">
        <button
          type="button"
          tabIndex={-1}
          aria-label={props.showLabel ?? props.moreLabel}
          title={props.showLabel ?? props.moreLabel}
          className="absolute bottom-2 left-2 z-10 flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-neutral-900/80 text-white shadow-lg"
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => setState("base")}
        >
          <ChevronUp className="h-5 w-5" />
        </button>
      </div>
    );
  }

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
            const title = more && props.hideHint ? `${label} · ${props.hideHint}` : label;
            return (
              <button
                key={def.id}
                type="button"
                tabIndex={-1}
                aria-label={label}
                title={title}
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
                {more && !expanded && <ChevronDown aria-hidden className="pointer-events-none absolute bottom-0.5 right-1 h-2.5 w-2.5 text-white/40" />}
                {def.popup && <span aria-hidden className="pointer-events-none absolute right-1 top-0.5 text-[9px] leading-none text-white/45">{def.popup}</span>}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
