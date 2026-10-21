/**
 * Instant input for on-screen keyboards in the terminal.
 *
 * Android keyboards with word suggestions (Gboard and most others) type a
 * word as a "composition" and commit it on space; xterm.js sends the word
 * only then, so shells that highlight as you type see nothing until the
 * space. This takes over the terminal's hidden textarea instead: every change
 * to it (composition or not) is sent at once as the difference to what was
 * sent before, Backspace (DEL) for what went away. Between words the
 * textarea is reset to a single space, so the keyboard has no old word to
 * reopen and Backspace always arrives as an edit. Keys sent as real key
 * events (Enter, a hardware keyboard) stay with xterm.
 */
export function attachInstantInput(term: { textarea?: HTMLTextAreaElement; element?: HTMLElement }, send: (data: string) => void): () => void {
  const ta = term.textarea;
  const root = term.element;
  if (!ta || !root) return () => {};
  let sent = ""; // what the textarea held at the last send
  let composing = false;
  const reset = () => {
    ta.value = SENTINEL;
    ta.setSelectionRange(SENTINEL.length, SENTINEL.length);
    sent = SENTINEL;
  };
  // xterm empties the textarea on Enter, Ctrl+C and blur: start from what is there
  const resync = () => {
    if (!composing && ta.value !== sent) sent = ta.value;
  };
  let clearTimer: ReturnType<typeof setTimeout> | null = null;

  const sync = () => {
    const now = ta.value;
    if (now === sent) return;
    let i = 0;
    while (i < sent.length && i < now.length && sent[i] === now[i]) i++;
    // do not split a surrogate pair
    if (i > 0 && i < sent.length && isLowSurrogate(sent.charCodeAt(i))) i--;
    const removed = [...sent.slice(i)].length;
    sent = now;
    const data = "\x7f".repeat(removed) + now.slice(i).replace(/\n/g, "\r");
    if (data) send(data);
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
  const onCompositionUpdate = (e: Event) => {
    if (own(e)) sync();
  };
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
  // Keyboards report their keys as keyCode 229; xterm would diff the textarea itself.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.keyCode === 229) own(e);
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
  return () => {
    if (clearTimer !== null) clearTimeout(clearTimer);
    ta.removeEventListener("focus", onFocus);
    root.removeEventListener("beforeinput", onBeforeInput, opts);
    root.removeEventListener("compositionstart", onCompositionStart, opts);
    root.removeEventListener("compositionupdate", onCompositionUpdate, opts);
    root.removeEventListener("compositionend", onCompositionEnd, opts);
    root.removeEventListener("input", onInput, opts);
    root.removeEventListener("keydown", onKeyDown, opts);
  };
}

/** Kept in the textarea between words (see above). */
const SENTINEL = " ";
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;
