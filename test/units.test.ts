import { describe, expect, it } from "vitest";
import { create, toBinary } from "@bufbuild/protobuf";
import { constants as zlibConstants, zstdCompressSync } from "node:zlib";
import { NatType, RendezvousMessageSchema } from "../src/proto/rendezvous_pb.js";
import { MessageSchema } from "../src/proto/session_pb.js";
import { StreamCipher, loginProof, rememberedPasswordHash } from "../src/crypto.js";
import { mapCode, peerOsFromPlatform } from "../src/keymap.js";
import { inflateCapped, inflateExact } from "../src/zstd.js";
import { classifyPeerError } from "../src/files/job.js";
import { announcedRelayUrl, relayUrlNextTo } from "../src/connector.js";
import { baseNameRemote, joinRemote, parentRemote, safeRelativeSegments } from "../src/files/paths.js";

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

  it("encodes file transfer messages byte-compatibly", () => {
    const enc = (init: Parameters<typeof create<typeof MessageSchema>>[1]) => hex(toBinary(MessageSchema, create(MessageSchema, init)));
    // login_request(7) { file_transfer(7) { dir(1): "a" } }
    expect(enc({ union: { case: "loginRequest", value: { union: { case: "fileTransfer", value: { dir: "a" } } } } })).toBe(
      "3a053a030a0161",
    );
    // file_action(17) { send_confirm(9) { id 1, file_num sint32 2, skip true } }
    expect(
      enc({
        union: {
          case: "fileAction",
          value: { union: { case: "sendConfirm", value: { id: 1, fileNum: 2, union: { case: "skip", value: true } } } },
        },
      }),
    ).toBe("8a01084a060801100418" + "01");
    // file_response(18) { block(2) { id 1, data 0102, compressed true } }
    expect(
      enc({
        union: {
          case: "fileResponse",
          value: { union: { case: "block", value: { id: 1, data: new Uint8Array([1, 2]), compressed: true } } },
        },
      }),
    ).toBe("92010a120808011a0201022001");
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

  it("refuses frames whose window the decoder would have to allocate up front", () => {
    // magic, no single segment, window 2^30, then one empty last raw block
    const hugeWindow = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, (30 - 10) << 3, 0x01, 0x00, 0x00]);
    expect(() => inflateCapped(hugeWindow, 1 << 20)).toThrow(/window/);
    // same frame with a 1 MiB window is fine
    const ok = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, (20 - 10) << 3, 0x01, 0x00, 0x00]);
    expect(inflateCapped(ok, 1 << 20).length).toBe(0);
    expect(() => inflateCapped(hugeWindow.subarray(0, 7), 1 << 20)).toThrow();
  });

  it("walks checksummed and concatenated frames", () => {
    const a = new Uint8Array(zstdCompressSync(new Uint8Array(3000).fill(1), { params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 } }));
    const b = new Uint8Array(zstdCompressSync(new TextEncoder().encode("tail")));
    const both = new Uint8Array([...a, ...b]);
    const out = inflateCapped(both, 4096);
    expect(out.length).toBe(3004);
    expect(new TextDecoder().decode(out.subarray(3000))).toBe("tail");
  });
});

describe("remote paths", () => {
  it("joins and splits POSIX paths", () => {
    expect(joinRemote("/home/a", "b.txt", "/")).toBe("/home/a/b.txt");
    expect(joinRemote("/", "etc", "/")).toBe("/etc");
    expect(parentRemote("/home/a", "/")).toBe("/home");
    expect(parentRemote("/home", "/")).toBe("/");
    expect(parentRemote("/", "/")).toBe("/");
    expect(baseNameRemote("/home/a/", "/")).toBe("a");
  });

  it("handles Windows drives and separators", () => {
    expect(joinRemote("/", "D:", "\\")).toBe("D:\\");
    expect(joinRemote("C:\\", "Users", "\\")).toBe("C:\\Users");
    expect(joinRemote("C:\\Users", "bob", "\\")).toBe("C:\\Users\\bob");
    expect(parentRemote("C:\\Users\\bob", "\\")).toBe("C:\\Users");
    expect(parentRemote("C:\\Users", "\\")).toBe("C:\\");
    expect(parentRemote("C:\\", "\\")).toBe("/");
    expect(baseNameRemote("C:\\Users\\bob", "\\")).toBe("bob");
    expect(baseNameRemote("D:\\", "\\")).toBe("D:");
  });

  it("refuses relative names that leave the target folder", () => {
    expect(safeRelativeSegments("a\\b/./c.txt")).toEqual(["a", "b", "c.txt"]);
    for (const bad of ["../x", "a/../../x", "/etc/passwd", "\\\\srv\\share", "C:\\x", "a\0b"]) {
      expect(() => safeRelativeSegments(bad), bad).toThrow();
    }
  });

  it("classifies peer error texts", () => {
    expect(classifyPeerError("No such file or directory (os error 2)")).toBe("not-found");
    expect(classifyPeerError("The system cannot find the path specified. (os error 3)")).toBe("not-found");
    expect(classifyPeerError("\"/x\" not exists")).toBe("not-found");
    expect(classifyPeerError("Access is denied. (os error 5)")).toBe("permission-denied");
    expect(classifyPeerError("Permission denied")).toBe("permission-denied");
    expect(classifyPeerError("Directory not empty (os error 39)")).toBe("not-empty");
    expect(classifyPeerError("The directory is not empty. (os error 145)")).toBe("not-empty");
    expect(classifyPeerError("File exists (os error 17)")).toBe("exists");
    expect(classifyPeerError("one-way-file-transfer-tip")).toBe("one-way");
    expect(classifyPeerError("file transfer rejected: too many files (20000 files exceeds limit of 10000)")).toBe("too-many-files");
    expect(classifyPeerError("path traversal detected in file name")).toBe("invalid-name");
    expect(classifyPeerError("disk on fire")).toBe("remote");
  });
});

describe("relay URLs", () => {
  it("defaults to hbbr next to hbbs", () => {
    expect(relayUrlNextTo("wss://rd.example.com/ws/id")).toBe("wss://rd.example.com/ws/relay");
    expect(relayUrlNextTo("wss://rd.example.com:8443/rd/ws/id?x=1")).toBe("wss://rd.example.com:8443/rd/ws/relay");
    expect(relayUrlNextTo("wss://rd.example.com/hbbs")).toBe("wss://rd.example.com/ws/relay");
    expect(relayUrlNextTo("ws://10.0.0.5:21118")).toBe("ws://10.0.0.5:21119/");
  });

  it("maps an announced relay on request", () => {
    expect(announcedRelayUrl("relay.example.com:21117")).toBe("wss://relay.example.com/ws/relay");
    expect(announcedRelayUrl("10.0.0.5:21117")).toMatch(/^wss?:\/\/10\.0\.0\.5:21119$/);
  });
});
