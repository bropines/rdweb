# rdweb

Browser remote desktop client for RustDesk-compatible servers. It talks to
hbbs/hbbr over WebSocket, authenticates the remote device end to end and
decodes video with WebCodecs. No plugins, no WebAssembly, no server-side
component besides the usual `/ws/id` and `/ws/relay` WebSocket endpoints.

rdweb is a library: a headless `Session` (protocol, crypto, media), a DOM
`Viewer` (rendering, cursor, mouse/touch/keyboard) and a headless
`FileTransferSession` (remote files). Host applications bring their own UI — [RD Panel](https://github.com/bropines/rdpanel) embeds it as its
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
- File transfer (same authentication and login, separate connection): browse
  remote folders (drives on Windows), download files and whole folders as
  streams (File System Access API, Blob, anything that takes a
  `ReadableStream`), upload files and folders with overwrite / skip / resume
  negotiation, create, rename and delete. Progress events, cancellation,
  bounded memory (zstd blocks are inflated with a hard cap, unread data is
  limited) and WebSocket backpressure on uploads.

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

### File transfer

```ts
import { FileTransferSession } from "rdweb";

const ft = new FileTransferSession({ peerId: "123456789", server });
ft.on("password", ({ wrong }) => askPassword(wrong).then((p) => ft.login(p)));
await ft.connect();

// "" is the remote user's home, "/" the drive list on Windows peers
const dir = await ft.listDir(ft.homeDir, { showHidden: false });
for (const e of dir.entries) console.log(e.type, e.name, e.size, new Date(e.modified));

// Download a folder (recursively) into a folder the user picked.
const target = await showDirectoryPicker({ mode: "readwrite" });
await ft.download(ft.joinPath(ft.homeDir, "Documents"), { onProgress }).saveTo(async (file) => {
  const parts = file.relativePath.split("/"); // "Documents/sub/a.txt"
  let d = target;
  for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
  return (await d.getFileHandle(parts.at(-1)!, { create: true })).createWritable();
});

// Or consume the files yourself, one at a time.
const job = ft.download("/var/log");
for await (const file of job) {
  if (file.size > 100 << 20) continue; // not read: skipped
  for await (const chunk of file) consume(file.relativePath, chunk);
}
await job.done;

// Small files straight into a Blob.
const { blob } = await ft.downloadBlob(ft.joinPath(ft.homeDir, "notes.txt"), { maxBytes: 16 << 20 });

// Upload from <input type="file" multiple> (or webkitdirectory for folders).
ft.on("conflict", ({ conflict, answer }) =>
  answer(confirm(`Replace ${conflict.file.relativePath}?`) ? "overwrite" : "skip"),
);
const up = ft.upload(input.files!, ft.homeDir, { onProgress }); // or overwrite: "overwrite" | "skip"
await up.done; // up.cancel() stops it and removes the partial file remotely

await ft.mkdir(ft.joinPath(ft.homeDir, "new folder"));
await ft.rename(ft.joinPath(ft.homeDir, "a.txt"), "b.txt");
await ft.remove(ft.joinPath(ft.homeDir, "old"), { dir: true, recursive: true });
```

Transfers run one at a time in the order they were started. Within a
download, handle each file before asking for the next one: the peer waits for
our go-ahead per file, which is given when the file is first read (a file that
is not read is skipped). The protocol cannot pause a file midway, so a
consumer slower than the network fails with `overflow` once
`maxBufferedBytes` (32 MiB by default) of unread data piled up. Errors
reported by the peer arrive as `FileTransferError` with a `code`
(`not-found`, `permission-denied`, `exists`, `not-empty`, ...) on the failing
promise and as an `error` event; a peer that disables file access ends
running transfers with `permission-denied`.

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
npm run dev       # demo page at http://127.0.0.1:5199 (remote desktop or files)
npm run gen       # regenerate src/proto from proto/*.proto (buf)
```

`test/e2e-node.mjs` runs a real session from Node against a live server and
device (frames are counted, not decoded).

## License

MIT, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
