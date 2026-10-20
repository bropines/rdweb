import { describe, expect, it } from "vitest";

import { decodeConfigString, endpoints, entryFromConfig, hostOf, keyProblem, toServerConfig } from "../../app/src/servers.js";

const key = Buffer.alloc(32, 7).toString("base64");
// What RD Panel's Server page and the RustDesk client export: URL-safe base64 (no padding) of the JSON, reversed.
const encode = (o: object) => [...Buffer.from(JSON.stringify(o)).toString("base64url")].reverse().join("");

describe("RustDesk config strings", () => {
  const cfg = { host: "rd.example.com", relay: "rd.example.com", key, api: "https://rd.example.com" };

  it("decodes the reversed URL-safe base64 form, also inside a CLI line", () => {
    expect(decodeConfigString(encode(cfg))).toEqual(cfg);
    expect(decodeConfigString(`rustdesk --config "${encode(cfg)}"`)).toEqual(cfg);
    // the RustDesk client keeps the padding, which ends up in front
    const padded = [...Buffer.from(JSON.stringify({ host: "a.example", key })).toString("base64url").padEnd(64, "=")].reverse().join("");
    expect(decodeConfigString(padded).host).toBe("a.example");
  });

  it("accepts plain base64 and JSON, rejects other text", () => {
    expect(decodeConfigString(Buffer.from(JSON.stringify(cfg)).toString("base64")).key).toBe(key);
    expect(decodeConfigString(JSON.stringify({ host: "x.example", key })).host).toBe("x.example");
    expect(() => decodeConfigString("hello world")).toThrow();
    expect(() => decodeConfigString(encode({ foo: 1 }))).toThrow();
  });

  it("fills the form", () => {
    expect(entryFromConfig({ host: "rd.example.com:21116", relay: "rd.example.com:21117", key, api: "" })).toEqual({
      name: "rd.example.com",
      address: "rd.example.com",
      relay: undefined,
      key,
    });
    expect(entryFromConfig({ host: "id.example.com", relay: "relay.example.com", key, api: "" }).relay).toBe("relay.example.com");
    expect(entryFromConfig({ host: "", relay: "", key, api: "https://panel.example.com" }).address).toBe("panel.example.com");
  });
});

describe("endpoints", () => {
  it("derives /ws/id and /ws/relay over TLS from a host", () => {
    expect(hostOf("https://RD.example.com/connect")).toBe("rd.example.com");
    expect(hostOf("rd.example.com:21116")).toBe("rd.example.com");
    expect(hostOf("rd.example.com:8443")).toBe("rd.example.com:8443");
    expect(endpoints("rd.example.com")).toEqual({ rendezvousUrl: "wss://rd.example.com/ws/id", relayUrl: "wss://rd.example.com/ws/relay" });
    expect(endpoints("rd.example.com", "relay.example.com")).toEqual({
      rendezvousUrl: "wss://rd.example.com/ws/id",
      relayUrl: "wss://relay.example.com/ws/relay",
    });
  });

  it("uses WebSocket URLs as given", () => {
    expect(endpoints("wss://rd.example.com/custom/id")).toEqual({ rendezvousUrl: "wss://rd.example.com/custom/id", relayUrl: undefined });
    const s = toServerConfig({ id: "1", name: "x", address: "wss://a.example/ws/id", relay: "wss://b.example/r", key: ` ${key} ` });
    expect(s.rendezvousUrl).toBe("wss://a.example/ws/id");
    expect(s.relayUrl?.("b.example:21117")).toBe("wss://b.example/r");
    expect(s.key).toBe(key);
  });

  it("validates the server key", () => {
    expect(keyProblem(key)).toBeNull();
    expect(keyProblem("abc")).toMatch(/bytes|base64/);
  });
});
