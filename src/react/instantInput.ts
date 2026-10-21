/**
 * Instant input for on-screen keyboards in the terminal.
 *
 * Android keyboards with word suggestions (Gboard, Yandex and most others)
 * type a word as a "composition" and commit it on space; xterm.js sends the
 * word only then, so shells that highlight as you type see nothing until the
 * space. This takes over the terminal's hidden textarea instead: every change
 * to it (composition or not) is sent at once as the difference to what was
 * sent before, Backspace (DEL) for what went away before the caret, Delete
 * for what went after it.
 *
 * Between words the textarea is reset to a few spaces on each side of the
 * caret, so the keyboard has no old word to reopen, Backspace and Delete
 * always arrive as edits, and a keyboard's own cursor keys (the arrows of
 * Yandex's or Gboard's editing panel move the caret, not send keys) can be
 * told apart: a caret moved by n becomes n arrow keys, one moved to the
 * start or the end Home or End. Keys sent as real key events (Enter, a
 * hardware keyboard, keyboards whose arrows are key events) stay with xterm.
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
  let sent = ""; // what the textarea held at the last send
  let caret = 0; // where the caret was then
  let composing = false;
  const reset = () => {
    ta.value = PAD + PAD;
    ta.setSelectionRange(PAD.length, PAD.length);
    sent = ta.value;
    caret = PAD.length;
  };
  // xterm empties the textarea on Enter, Ctrl+C and blur: start from what is there
  const resync = () => {
    if (composing || ta.value === sent) return;
    sent = ta.value;
    caret = ta.selectionStart ?? sent.length;
  };
  let clearTimer: ReturnType<typeof setTimeout> | null = null;

  const sync = () => {
    const now = ta.value;
    const after = ta.selectionStart ?? now.length;
    if (now !== sent) {
      // Edits happen at the caret: the unchanged prefix ends before both
      // carets, the unchanged suffix starts after both (the padding is all
      // spaces, so without the carets a Backspace would look like a Delete).
      const maxPre = Math.min(caret, after, sent.length, now.length);
      let i = 0;
      while (i < maxPre && sent[i] === now[i]) i++;
      const maxSuf = Math.min(sent.length - Math.max(i, caret), now.length - Math.max(i, after));
      let j = 0;
      while (j < maxSuf && sent[sent.length - 1 - j] === now[now.length - 1 - j]) j++;
      // do not split a surrogate pair
      if (i > 0 && isLowSurrogate(sent.charCodeAt(i))) i--;
      if (j > 0 && isLowSurrogate(sent.charCodeAt(sent.length - j))) j--;
      const end = sent.length - j;
      const removedBefore = [...sent.slice(i, Math.max(i, Math.min(caret, end)))].length;
      const removedAfter = [...sent.slice(Math.max(i, caret), end)].length;
      const added = now.slice(i, now.length - j).replace(/\n/g, "\r");
      sent = now;
      for (let k = 0; k < removedAfter; k++) sendKey("del");
      const data = "\x7f".repeat(removedBefore) + added;
      if (data) send(data);
    }
    caret = after;
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
  // The caret moved without an edit: the keyboard's cursor keys.
  const onSelectionChange = () => {
    if (composing || document.activeElement !== ta || ta.value !== sent) return;
    const start = ta.selectionStart ?? caret;
    if (start !== ta.selectionEnd || start === caret) return; // a selection, or no move
    const delta = start - caret;
    if (start === 0 && delta < -1) sendKey("home");
    else if (start === ta.value.length && delta > 1) sendKey("end");
    else for (let k = 0; k < Math.abs(delta); k++) sendKey(delta < 0 ? "left" : "right");
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
const PAD = "        ";
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;
