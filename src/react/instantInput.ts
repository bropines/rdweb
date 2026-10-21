/**
 * Instant input for on-screen keyboards in the terminal.
 *
 * Android keyboards with word suggestions (Gboard, Yandex and most others)
 * type a word as a "composition" and commit it on space; xterm.js sends the
 * word only then, so shells that highlight as you type see nothing until the
 * space. This takes over the terminal's hidden textarea instead: every change
 * to the text before the caret is sent at once as the difference to what was
 * sent before (Backspace, DEL, for what went away), and text going away after
 * the caret is sent as Delete.
 *
 * Between words the textarea is reset to a few spaces on each side of the
 * caret: the keyboard has no old word to reopen, Backspace and Delete always
 * have something to delete, and the cursor keys of a keyboard's editing panel
 * all have somewhere to go (Yandex Keyboard sends nothing for → ↓ when the
 * caret is at the end). Those keys arrive as real key events and stay with
 * xterm, except Yandex's start/end keys, sent as Alt+Shift+↓/↑, which become
 * Home and End; a caret the keyboard moves itself (to the start or the end,
 * or by a few characters) becomes Home, End or arrows.
 *
 * The caret is read only after an edit (input, compositionend), never during
 * compositionupdate: Chrome selects the composed word for a moment before the
 * keyboard replaces it.
 */
export type InstantKey = "left" | "right" | "home" | "end" | "del";

export function attachInstantInput(
  term: { textarea?: HTMLTextAreaElement; element?: HTMLElement },
  send: (data: string) => void,
  sendKey: (key: InstantKey) => void = () => {},
): () => void {
  const ta = term.textarea;
  const root = term.element;
  if (!ta || !root) return () => {};
  // what the textarea held at the last send, split at the caret
  let before = "";
  let after = "";
  let composing = false;
  let clearTimer: ReturnType<typeof setTimeout> | null = null;

  const caretNow = () => ta.selectionEnd ?? ta.value.length;
  const reset = () => {
    ta.value = PAD + PAD;
    ta.setSelectionRange(PAD.length, PAD.length);
    before = PAD;
    after = PAD;
  };
  /** Takes the textarea as it is (xterm empties it on Enter, Ctrl+C and blur). */
  const adopt = () => {
    const c = caretNow();
    before = ta.value.slice(0, c);
    after = ta.value.slice(c);
  };
  const resync = () => {
    if (!composing && ta.value !== before + after) adopt();
  };

  const sync = () => {
    const c = caretNow();
    const nowBefore = ta.value.slice(0, c);
    const nowAfter = ta.value.slice(c);
    if (nowBefore !== before) {
      let i = 0;
      while (i < before.length && i < nowBefore.length && before[i] === nowBefore[i]) i++;
      if (i > 0 && isLowSurrogate(before.charCodeAt(i))) i--; // do not split a surrogate pair
      const removed = [...before.slice(i)].length;
      const data = "\x7f".repeat(removed) + nowBefore.slice(i).replace(/\n/g, "\r");
      if (data) send(data);
    }
    // text after the caret that went away (and still ends the same): Delete
    if (nowAfter.length < after.length && after.endsWith(nowAfter)) {
      for (let k = [...after].length - [...nowAfter].length; k > 0; k--) sendKey("del");
    }
    before = nowBefore;
    after = nowAfter;
  };
  const clearSoon = () => {
    if (clearTimer !== null) clearTimeout(clearTimer);
    clearTimer = setTimeout(() => {
      clearTimer = null;
      if (!composing) reset();
    }, 0);
  };
  const own = (e: Event) => {
    if (e.target !== ta) return false;
    e.stopPropagation(); // xterm's own handlers on the textarea would send it again
    return true;
  };

  const onCompositionStart = (e: Event) => {
    if (!own(e)) return;
    resync();
    composing = true;
    if (clearTimer !== null) {
      clearTimeout(clearTimer);
      clearTimer = null;
    }
  };
  // every update is followed by an input event, which reads the result
  const onCompositionUpdate = (e: Event) => void own(e);
  const onCompositionEnd = (e: Event) => {
    if (!own(e)) return;
    composing = false;
    sync();
    clearSoon();
  };
  const onInput = (e: Event) => {
    if (!own(e)) return;
    sync();
    if (!composing) clearSoon();
  };
  const onBeforeInput = (e: Event) => {
    if (e.target === ta) resync();
  };
  const onFocus = () => {
    if (ta.value === "") reset();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    // Keyboards report their keys as keyCode 229; xterm would diff the textarea itself.
    if (e.keyCode === 229) {
      own(e);
      return;
    }
    // Yandex Keyboard's start and end keys (|< >|) arrive as Alt+Shift+↓ and Alt+Shift+↑
    if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && (e.key === "ArrowDown" || e.key === "ArrowUp") && own(e)) {
      e.preventDefault();
      sendKey(e.key === "ArrowDown" ? "home" : "end");
    }
  };
  // The caret moved without an edit: the keyboard moved it itself.
  const onSelectionChange = () => {
    if (composing || clearTimer !== null || document.activeElement !== ta || ta.value !== before + after) return;
    const pos = ta.selectionStart ?? 0;
    if (pos !== ta.selectionEnd || pos === before.length) return; // a selection, or no move
    if (pos === 0) sendKey("home");
    else if (pos === ta.value.length) sendKey("end");
    else {
      const delta = pos - before.length;
      for (let k = Math.abs(delta); k > 0; k--) sendKey(delta < 0 ? "left" : "right");
    }
    reset();
  };

  const opts = { capture: true };
  reset();
  ta.addEventListener("focus", onFocus);
  root.addEventListener("beforeinput", onBeforeInput, opts);
  root.addEventListener("compositionstart", onCompositionStart, opts);
  root.addEventListener("compositionupdate", onCompositionUpdate, opts);
  root.addEventListener("compositionend", onCompositionEnd, opts);
  root.addEventListener("input", onInput, opts);
  root.addEventListener("keydown", onKeyDown, opts);
  document.addEventListener("selectionchange", onSelectionChange);
  return () => {
    if (clearTimer !== null) clearTimeout(clearTimer);
    ta.removeEventListener("focus", onFocus);
    root.removeEventListener("beforeinput", onBeforeInput, opts);
    root.removeEventListener("compositionstart", onCompositionStart, opts);
    root.removeEventListener("compositionupdate", onCompositionUpdate, opts);
    root.removeEventListener("compositionend", onCompositionEnd, opts);
    root.removeEventListener("input", onInput, opts);
    root.removeEventListener("keydown", onKeyDown, opts);
    document.removeEventListener("selectionchange", onSelectionChange);
  };
}

/** Kept on each side of the caret between words (see above). */
const PAD = " ".repeat(8);
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;
