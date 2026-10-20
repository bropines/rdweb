# rdweb

Browser remote desktop client for RustDesk-compatible servers. It talks to
hbbs/hbbr over WebSocket, authenticates the remote device end to end and
decodes video with WebCodecs. No plugins, no WebAssembly, no server-side
component besides the usual `/ws/id` and `/ws/relay` WebSocket endpoints.

rdweb is a library: a headless `Session` (protocol, crypto, media), a DOM
`Viewer` (rendering, cursor, mouse/touch/keyboard) and a headless
`FileTransferSession` (remote files). An optional React UI, `rdweb/react`,
provides the complete remote desktop screen (toolbar, settings, files, login
dialogs) — [RD Panel](https://github.com/bropines/rdpanel) embeds it as its
web client, and the [standalone web client](#standalone-web-client) at
<https://bropines.github.io/rdweb/> is built from it.

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
- Terminal (`TerminalSession`, RustDesk 1.4.1+ peers): a remote shell over its
  own connection (PowerShell/cmd on Windows, the user's shell elsewhere), with
  resize and zstd-compressed output. The React terminal has its own settings
  (font installed on the computer, size) and shows prompt icons (oh-my-posh,
  starship) through a built-in Symbols Nerd Font loaded on demand.
- Pasting (Ctrl/Cmd+V) or dropping files onto the remote screen uploads them
  through the file manager; pasted text goes to the remote clipboard first.

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
typically through a reverse proxy at `/ws/id` and `/ws/relay`. By default the
relay is reached next to hbbs (`relayUrlNextTo`: `wss://host/ws/id` →
`wss://host/ws/relay`), because the relay hbbs announces is a TCP address for
native clients; pass `relayUrl` to override, e.g. `relayUrl: announcedRelayUrl`
to map an announced `host:21117` to `wss://host/ws/relay`. A failed WebSocket
connection to either server is a `SessionError` with code `unreachable`.

Browser support: Chromium-based browsers and Safari 17+ (WebCodecs). Firefox
130+ decodes VP8/VP9/AV1. H.265 depends on platform decoders.

## React UI (`rdweb/react`)

```tsx
import { RemoteDesktop, Toaster } from "rdweb/react";
import "rdweb/react/style.css"; // only without your own Tailwind build, see Styling

<Toaster />
<RemoteDesktop
  peerId="123456789"
  server={{ rendezvousUrl: "wss://rd.example.com/ws/id", relayUrl: () => "wss://rd.example.com/ws/relay", key }}
  lang="en"
  onLeave={() => navigate("/")}
/>
```

`RemoteDesktop` renders a fixed, full-viewport session: video and input, a
floating toolbar (pinnable and reorderable actions, auto-hide, draggable), the
settings and files sheets, password / 2FA / clipboard / type text / chat /
restart dialogs, the extra-keys row for on-screen keyboards, the quality
monitor and visual-viewport handling. Settings, view options, the toolbar
layout, remembered password hashes and recent devices are kept in
localStorage. Keep it mounted for the session (unmounting disconnects);
changing `peerId` or the server starts a new session.

| prop | type | |
|---|---|---|
| `peerId` | `string` | device id |
| `server` | `ServerConfig` | hbbs/hbbr WebSocket endpoints and key, as for `Session` |
| `lang` | `"en" \| "ru"` | default `"en"` |
| `messages` | `DeepPartial<Messages>` | override any string, e.g. `{ toolbar: { back: "Back to the panel" } }` |
| `credentials` | `{ rememberedHash?: Uint8Array; password?: string; fromPersonalBook?: boolean }` | saved logins the host found. Tried in the desktop client's order: the hash remembered in this browser, `rememberedHash`, `password`, then the password dialog. With `fromPersonalBook`, a rejected `rememberedHash` calls `onForget` and "Forget saved password" is offered for it |
| `myName`, `myId` | `string` | shown to / announced to the remote side |
| `onLeave` | `() => void` | required; "Back" in the toolbar and the end-of-session overlay |
| `onReconnect` | `() => void` | default: remount internally (pass it to refetch credentials first) |
| `onRemembered` | `(hash: Uint8Array) => void \| Promise` | login with "remember" ticked; the hash is also stored in this browser. A rejected promise shows an error toast |
| `onForget` | `() => void \| Promise` | the saved password should be forgotten (see `credentials`) |
| `onConnected` | `(peer: PeerSummary) => void` | session is up |
| `storageKey` | `string` | localStorage prefix, default `"rdweb"` (`<prefix>.prefs`, `<prefix>.pw.<server key>.<peer>`, `<prefix>.recent`) |
| `rememberLabel`, `rememberHint` | `string` | text of the "remember" checkbox (e.g. "Remember in my account") |
| `extraActions` | `ToolbarAction[]` | more toolbar actions, pinnable like the built-in ones |
| `className` | `string` | classes for the shell |
| `mode` | `"desktop" \| "files" \| "terminal"` | `"files"`: only the file manager (a file transfer connection, no screen); `"terminal"`: only a remote shell (xterm.js, loaded on demand; extra keys on touch screens). Default `"desktop"` |

Also exported: `Toolbar` (with `ToolbarAction`, `ActionId`,
`DEFAULT_PINNED_DESKTOP/TOUCH`), `SettingsSheet`, `FilesSheet` (a complete
file manager on its own `FileTransferSession`; `inline` renders it as a page), `RemoteTerminal`, `Toaster`, `ZipWriter`,
`formatSize`, `loadRecent`/`pushRecent` and the other storage helpers
(`loadPrefs`, `loadRememberedHash`, `clearStoredData`, ...), `messages`
(`en`, `ru`), `createTranslator`, `I18nProvider`/`useI18n` and `cn`.

Notes:

- React (18 or 19), react-dom, `@radix-ui/react-{checkbox,dialog,dropdown-menu,label,select,separator,slot,switch}`,
  `lucide-react` and `sonner` are (optional) peer dependencies: install them
  in the host so there is one copy of each. The core entry `rdweb` never
  imports React.
- Events (chat, clipboard, errors) are reported with sonner's `toast()`: any
  sonner `<Toaster />` in the host shows them; render rdweb's `Toaster` if the
  host has none.
- Strings come from a built-in catalog (no i18next); English and Russian
  have the same keys, Russian plurals use `Intl.PluralRules`.
- `storageKey: "rdpanel.webclient"` reads RD Panel's existing data as it is
  (same layout) and removes the plaintext passwords of its first web client.

### Styling

The components are styled with Tailwind CSS 3 utility classes and the
[shadcn/ui](https://ui.shadcn.com) theme variables (`--background`,
`--foreground`, `--primary`, `--muted-foreground`, `--border`, `--ring`,
`--destructive`, ... as HSL triplets, plus `--radius`). Pick one:

1. **Your own Tailwind build** (hosts with shadcn/ui): add the compiled
   components to `content` and keep your theme. The config needs the shadcn
   color names mapped to the variables and the `tailwindcss-animate` plugin
   (the shadcn defaults); see [`tailwind.preset.js`](tailwind.preset.js).

   ```js
   content: ["./src/**/*.{ts,tsx}", "./node_modules/rdweb/dist/react/**/*.js"],
   ```

2. **The prebuilt stylesheet** (no Tailwind): `import "rdweb/react/style.css"`.
   It holds the utilities rdweb uses, the theme variables (light, and dark
   under a `dark` class on any ancestor such as `<html>`) and a base reset —
   all scoped to the `.rdweb` class that every rdweb root carries (the session
   shell and each dialog, sheet, menu and toast), so the host page is not
   reset. Override the variables on `.rdweb` to re-theme. Utility class names
   are Tailwind's, unprefixed.

## Standalone web client

<https://bropines.github.io/rdweb/> is a static page built from this
repository (`app/`): add a server, enter a device id, connect.

- **Server**: a host name (`rd.example.com` → `wss://rd.example.com/ws/id` and
  `wss://rd.example.com/ws/relay`) or the full hbbs WebSocket URL, an optional
  relay URL, and the public key (`id_ed25519.pub` next to hbbs, the "Key" in
  the RustDesk client's ID/Relay server settings). A RustDesk server config
  string ("Export server config" in the RustDesk client, RD Panel's Server
  page) fills the form; its HTTPS API server wins over the ID and relay
  addresses, which are TCP endpoints for native clients (often IP addresses,
  which browsers cannot use without a certificate).
- **The server must expose** hbbs and hbbr as WebSockets over TLS — `/ws/id`
  to hbbs port 21118, `/ws/relay` to hbbr port 21119 — e.g. through nginx,
  Caddy or angie with a certificate (pages served over HTTPS cannot open
  `ws://`). RD Panel does this out of the box.
- **Privacy**: everything runs in the browser; the page has no backend and no
  analytics, and its Content Security Policy permits no external requests
  other than WebSockets (which the app opens only to the servers you add). Device passwords go only to the device,
  inside the encrypted session; "remember password" keeps a salted hash, not
  the password, in this browser. Servers and settings stay in localStorage.

English and Russian, light/dark/system theme, phone layouts. The
[pages workflow](.github/workflows/pages.yml) deploys it on every push to
`main`.

## Development

```sh
npm ci
npm test          # unit tests + an in-memory server/peer session test
npm run build     # dist/
npm run dev       # demo page at http://127.0.0.1:5199 (remote desktop or files)
npm run dev:app   # standalone web client at http://127.0.0.1:5200/rdweb/
npm run build:app # app/dist (GitHub Pages)
npm run gen       # regenerate src/proto from proto/*.proto (buf)
```

`npm run build` compiles the core (`dist/`), the React UI (`dist/react/`) and
its stylesheet (`scripts/build-css.mjs` → `dist/react/style.css`).

`test/e2e-node.mjs` runs a real session from Node against a live server and
device (frames are counted, not decoded).

## License

MIT, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
