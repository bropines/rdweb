import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { crc32, ZipWriter } from "../../src/react/zip.js";

async function* chunks(...parts: string[]) {
  for (const p of parts) yield new TextEncoder().encode(p);
}

describe("zip", () => {
  it("computes CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("writes an archive that standard tools accept", async () => {
    const z = new ZipWriter();
    await z.add("docs/a.txt", Date.UTC(2026, 0, 2, 3, 4, 6), chunks("hello ", "world"));
    await z.add("docs/sub/ä.bin", 0, chunks(""));
    const blob = z.finish();
    const dir = mkdtempSync(join(tmpdir(), "rdweb-zip-"));
    const file = join(dir, "t.zip");
    writeFileSync(file, new Uint8Array(await blob.arrayBuffer()));
    const out = execFileSync("python3", [
      "-c",
      "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(';'.join(f'{i.filename}={z.read(i).decode()}' for i in z.infolist()))",
      file,
    ])
      .toString()
      .trim();
    expect(out).toBe("docs/a.txt=hello world;docs/sub/ä.bin=");
  });
});
