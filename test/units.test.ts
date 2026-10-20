import { describe, expect, it } from "vitest";
import { create, toBinary } from "@bufbuild/protobuf";
import { zstdCompressSync } from "node:zlib";
import { NatType, RendezvousMessageSchema } from "../src/proto/rendezvous_pb.js";
import { MessageSchema } from "../src/proto/session_pb.js";
import { StreamCipher, loginProof, rememberedPasswordHash } from "../src/crypto.js";
import { mapCode, peerOsFromPlatform } from "../src/keymap.js";
import { inflateCapped, inflateExact } from "../src/zstd.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("wire format", () => {
  it("encodes a punch hole request byte-compatibly", () => {
    const bytes = toBinary(
      RendezvousMessageSchema,
      create(RendezvousMessageSchema, {
        union: { case: "punchHoleRequest", value: { id: "12", natType: NatType.SYMMETRIC, licenceKey: "k" } },
      }),
    );
    // field 8 (len) { 1:"12", 2:varint 2, 3:"k" }
    expect(hex(bytes)).toBe("42090a02313210021a016b");
  });

  it("encodes a mouse event with zigzag coordinates", () => {
    const bytes = toBinary(
      MessageSchema,
      create(MessageSchema, { union: { case: "mouseEvent", value: { mask: 9, x: -1, y: 2 } } }),
    );
    // field 10 { 1: 9, 2: zigzag(-1)=1, 3: zigzag(2)=4 }
    expect(hex(bytes)).toBe("5206080910011804");
  });
});

describe("crypto", () => {
  it("computes the RustDesk password proof", async () => {
    const h = await rememberedPasswordHash("pw", "salt");
    const proof = await loginProof(h, "ch");
    const { createHash } = await import("node:crypto");
    const h1 = createHash("sha256").update("pw").update("salt").digest();
    const p = createHash("sha256").update(h1).update("ch").digest();
    expect(hex(proof)).toBe(p.toString("hex"));
  });

  it("uses independent little-endian counters per direction", () => {
    const key = new Uint8Array(32).fill(7);
    const a = new StreamCipher(key.slice());
    const b = new StreamCipher(key.slice());
    const m1 = a.seal(new Uint8Array([1, 2, 3]));
    const m2 = a.seal(new Uint8Array([4]));
    expect(Array.from(b.open(m1))).toEqual([1, 2, 3]);
    expect(Array.from(b.open(m2))).toEqual([4]);
    // keep-alive frames pass through untouched
    expect(Array.from(b.open(new Uint8Array([0])))).toEqual([0]);
    expect(() => b.open(m1)).toThrow();
  });
});

describe("keymap", () => {
  it("maps physical keys per peer platform", () => {
    expect(mapCode("KeyA", "windows")).toBe(0x1e);
    expect(mapCode("KeyA", "linux")).toBe(30 + 8);
    expect(mapCode("KeyA", "macos")).toBe(0x00);
    expect(mapCode("ArrowUp", "windows")).toBe(0xe048);
    expect(mapCode("MetaLeft", "linux")).toBe(133);
    expect(mapCode("Nope", "windows")).toBeUndefined();
    expect(peerOsFromPlatform("Mac OS")).toBe("macos");
    expect(peerOsFromPlatform("Linux")).toBe("linux");
  });
});

describe("zstd", () => {
  it("inflates and enforces limits", () => {
    const data = new Uint8Array(1000).fill(3);
    const z = new Uint8Array(zstdCompressSync(data));
    expect(inflateExact(z, 1000).length).toBe(1000);
    expect(() => inflateExact(z, 999)).toThrow();
    const bomb = new Uint8Array(zstdCompressSync(new Uint8Array(50_000_000)));
    expect(() => inflateCapped(bomb, 1 << 20)).toThrow();
  });
});
