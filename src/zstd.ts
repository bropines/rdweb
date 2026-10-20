import { Decompress } from "fzstd";

/**
 * Inflates zstd data, refusing to produce more than `max` bytes so a
 * malicious peer cannot make us allocate unbounded memory.
 */
export function inflateCapped(data: Uint8Array, max: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const d = new Decompress((chunk) => {
    total += chunk.length;
    if (total > max) throw new Error(`zstd: inflated size exceeds ${max} bytes`);
    chunks.push(chunk.slice());
  });
  d.push(data, true);
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Inflates zstd data that must decompress to exactly `expected` bytes. */
export function inflateExact(data: Uint8Array, expected: number): Uint8Array {
  const out = inflateCapped(data, expected);
  if (out.length !== expected) throw new Error(`zstd: expected ${expected} bytes, got ${out.length}`);
  return out;
}
