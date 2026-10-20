# rdweb

Browser remote desktop client for RustDesk-compatible servers. It talks to
hbbs/hbbr over WebSocket, authenticates the remote device end to end and
decodes video with WebCodecs. No plugins, no WebAssembly, no server-side
component besides the usual `/ws/id` and `/ws/relay` WebSocket endpoints.

rdweb is a library: a headless `Session` (protocol, crypto, media) and a DOM
`Viewer` (rendering, cursor, mouse/touch/keyboard). Host applications bring
their own UI — [RD Panel](https://github.com/bropines/rdpanel) embeds it as its
web client.

## Features

- Authenticated, encrypted sessions: the server key vouches for the device key,
  the device signs its session key; anything that does not verify is refused
  (no silent fallback to an unauthenticated connection).
- Password, remembered password (salted hash, never the plain password),
  2FA, and "accept on the remote side" logins.
- Video: VP8, VP9, AV1, H.264, H.265 via WebCodecs (hardware where available),
  4:4:4 "true color" for VP9/AV1, live codec switching, key-frame recovery and
  latency-bounded decoding.
- Image quality presets and custom quality/FPS, remote resolution change,
  multiple displays, privacy mode, block input, lock after session end,
  view-only mode, follow remote cursor/window.
- Remote cursor shapes as the local pointer (or drawn as an overlay for
  touch input and "show remote cursor").
- Mouse, wheel and smooth touchpad scrolling; touch screens as a touchpad or as
  direct touch, with pinch zoom.
- Keyboard in Map (physical keys, layout of the remote side), Translate and
  Legacy modes; IME and on-screen keyboards; Ctrl+Alt+Del, lock screen.
- Text clipboard both ways, Opus audio, chat messages.

## Usage

```ts
import { Session, Viewer } from "rdweb";

const session = new Session({
  peerId: "123456789",
  server: {
    rendezvousUrl: "wss://rd.example.com/ws/id",
    relayUrl: () => "wss://rd.example.com/ws/relay",
    key: "<contents of id_ed25519.pub>",
  },
  settings: { imageQuality: "balanced", codec: "auto" },
});
const viewer = new Viewer(document.getElementById("screen")!, session);

session.on("password", ({ wrong }) => askPassword(wrong).then((p) => session.login(p)));
session.on("twoFactor", () => askCode().then((c) => session.submitTwoFactor(c)));
session.on("connected", ({ rememberedHash }) => maybeStore(rememberedHash));
session.on("close", ({ reason }) => console.log(reason));

await session.connect();
session.updateSettings({ imageQuality: "custom", customQuality: 80, customFps: 60 });
```

The server must expose hbbs (port 21118) and hbbr (port 21119) WebSockets,
typically through a reverse proxy at `/ws/id` and `/ws/relay`. By default a
relay announced as `host:21117` is reached at `wss://host/ws/relay` (or
`ws(s)://ip:21119` for IP addresses); pass `relayUrl` to override.

Browser support: Chromium-based browsers and Safari 17+ (WebCodecs). Firefox
130+ decodes VP8/VP9/AV1. H.265 depends on platform decoders.

## Development

```sh
npm ci
npm test          # unit tests + an in-memory server/peer session test
npm run build     # dist/
npm run dev       # demo page at http://127.0.0.1:5199
npm run gen       # regenerate src/proto from proto/*.proto (buf)
```

`test/e2e-node.mjs` runs a real session from Node against a live server and
device (frames are counted, not decoded).

## License

MIT, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
