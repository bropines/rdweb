/** Touch selection helpers for xterm.js, which selects only with a mouse. */

/** A cell in buffer coordinates (row counts from the top of the scrollback). */
export interface Cell {
  col: number;
  row: number;
}

interface TermLike {
  cols: number;
  rows: number;
  element?: HTMLElement;
  buffer: {
    active: {
      viewportY: number;
      getLine(y: number): { getCell(x: number): { getChars(): string; getWidth(): number } | undefined } | undefined;
    };
  };
  select(column: number, row: number, length: number): void;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The cell under a point on the screen. */
export function cellAt(term: TermLike, x: number, y: number): Cell {
  const screen = term.element?.querySelector(".xterm-screen") ?? term.element;
  const r = screen?.getBoundingClientRect();
  if (!r || !r.width || !r.height) return { col: 0, row: term.buffer.active.viewportY };
  const col = clamp(Math.floor(((x - r.left) / r.width) * term.cols), 0, term.cols - 1);
  const row = clamp(Math.floor(((y - r.top) / r.height) * term.rows), 0, term.rows - 1);
  return { col, row: row + term.buffer.active.viewportY };
}

/** The word around a cell (characters up to the nearest spaces); a blank cell alone. */
export function wordAt(term: TermLike, at: Cell): { start: Cell; end: Cell } {
  const line = term.buffer.active.getLine(at.row);
  const blank = (col: number) => {
    const cell = line?.getCell(col);
    if (!cell) return true;
    if (cell.getWidth() === 0) return false; // the right half of a wide character
    const ch = cell.getChars();
    return ch === "" || ch === " ";
  };
  if (!line || blank(at.col)) return { start: at, end: at };
  let start = at.col;
  let end = at.col;
  while (start > 0 && !blank(start - 1)) start--;
  while (end < term.cols - 1 && !blank(end + 1)) end++;
  return { start: { col: start, row: at.row }, end: { col: end, row: at.row } };
}

const before = (a: Cell, b: Cell) => a.row < b.row || (a.row === b.row && a.col <= b.col);

/** Selects from a to b (in either order), both cells included. */
export function selectBetween(term: TermLike, a: Cell, b: Cell): void {
  const [from, to] = before(a, b) ? [a, b] : [b, a];
  term.select(from.col, from.row, (to.row - from.row) * term.cols + (to.col - from.col) + 1);
}

/** The selection a drag makes from a long-pressed word to a cell: the word always stays in. */
export function extendFrom(word: { start: Cell; end: Cell }, to: Cell): [Cell, Cell] {
  return before(to, word.start) ? [to, word.end] : before(word.end, to) ? [word.start, to] : [word.start, word.end];
}
