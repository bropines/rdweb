/** Human-readable byte count ("512 B", "1.5 MB") in the given locale. */
export function formatSize(n: number, lang?: string): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString(lang, { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
}
