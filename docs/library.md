# Library reference (`rdweb`)

The core entry point has no UI and never imports React. It contains three
session types that share one connection layer, a DOM viewer for the remote
desktop, a server check, and a few helpers.

| export | what it is |
|---|---|
| [`Session`](#session) | a remote desktop session: video, audio, input, clipboard, chat |
| [`Viewer`](#viewer) | renders a `Session` into a DOM element and turns mouse, touch and keyboard input into remote input |
| [`FileTransferSession`](#filetransfersession) | the remote file system: list, download, upload, create, rename, delete |
| [`TerminalSession`](#terminalsession) | remote shells in tabs (RustDesk 1.4.1+ devices) |
| [`checkServer`](#checkserver) | checks what a browser needs from a server without contacting a device |
| [`ServerConfig`](#serverconfig), [`relayUrlNextTo`, `announcedRelayUrl`](#relay-urls) | where the ID server (hbbs) and the relay (hbbr) are, and the server key |
| [`SessionError`, `FileTransferError`](#errors) | errors with a machine-readable `code` |

Contents:

- [Installation](#installation)
- [How a connection works](#how-a-connection-works)
- [ServerConfig](#serverconfig)
- [Session](#session)
- [Viewer](#viewer)
- [FileTransferSession](#filetransfersession)
- [TerminalSession](#terminalsession)
- [checkServer](#checkserver)
- [Errors](#errors)
- [Other exports](#other-exports)
- [Running outside a browser](#running-outside-a-browser)

## Installation

rdweb is not published to the npm registry. Every [GitHub
release](https://github.com/bropines/rdweb/releases) has the package attached as
a tarball; install it by URL (replace the version with the latest release):

```sh
npm install https://github.com/bropines/rdweb/releases/download/v0.6.5/rdweb-0.6.5.tgz
```

The package is ESM only (`"type": "module"`) and ships TypeScript types. Its
runtime dependencies are `@bufbuild/protobuf`, `tweetnacl`, `fzstd`,
`opus-decoder` and, for the terminal UI, the `@xterm/*` packages. The
`rdweb/react` entry needs extra peer dependencies; see
[react.md](react.md#installation).

## How a connection works

Every session type opens its own connection to the device and goes through
the same steps. `state` events report them as they happen:

| state | what happens |
|---|---|
| `idle` | created, `connect()` not called yet |
| `rendezvous` | a WebSocket to hbbs (`/ws/id`) asks for the device and gets back a relay ticket and the device's key, signed with the server key |
| `relay` | a WebSocket to hbbr (`/ws/relay`) joins the relay pair for that ticket |
| `handshake` | the device proves its identity; a session key is sealed to it; everything after this is encrypted end to end |
| `login` | password, remembered password hash, 2FA or approval on the remote side |
| `connected` | the session is up |
| `closed` | ended; `close` was emitted with the reason |

A browser cannot accept a direct (P2P) connection, so the request always asks
for the relay. Anything that does not verify is refused: there is no fallback
to an unauthenticated connection. The details are in
[security.md](security.md).

## ServerConfig

Passed as `server` to every session type and to `checkServer`.

```ts
interface ServerConfig {
  /** WebSocket URL of hbbs, e.g. wss://rd.example.com/ws/id */
  rendezvousUrl: string;
  /** Maps the relay hbbs announces (host:port) to a WebSocket URL. */
  relayUrl?: (relayServer: string) => string;
  /** The server's public key: base64 Ed25519, the contents of id_ed25519.pub. Required. */
  key: string;
  /** Client access token, for servers that require a signed-in client. */
  token?: string;
}
```

- `key` is required. Session constructors parse it right away and throw if it
  is not a 32-byte base64 key, so a misconfigured key never reaches the
  network.
- `token` is sent with the rendezvous request. Servers running hbbs with
  `MUST_LOGIN=Y` refuse requests without a valid one (error code
  `login-required`). RD Panel hands its web client a short-lived token.

### Relay URLs

hbbs tells the client which relay the device will use, as a TCP address for
native clients (`host:21117`). A browser needs a WebSocket URL instead:

| `relayUrl` | relay WebSocket used |
|---|---|
| omitted (default) | `relayUrlNextTo(rendezvousUrl)`: the relay next to hbbs |
| `() => "wss://relay.example.com/ws/relay"` | a fixed URL |
| `announcedRelayUrl` | derived from the announced relay, for setups where every relay has its own TLS proxy |

`relayUrlNextTo(url)` maps `wss://host/ws/id` to `wss://host/ws/relay`, a
direct `ws://host:21118` to `ws://host:21119`, and any other path to
`/ws/relay` on the same host.

`announcedRelayUrl(relayServer)` maps a host name to `wss://<host>/ws/relay`
and an IP address `ip:port` to `ws(s)://ip:<port + 2>` (`wss` unless the page
itself is served over plain HTTP).

The default works when the device's relay and the browser's relay are the same
hbbr, which is the case for a single-host server. See
[server-setup.md](server-setup.md#the-relay) for multi-relay setups.

## Session

A remote desktop session. Create one per connection attempt: `connect()` can
be called only once.

```ts
import { Session, Viewer } from "rdweb";

const session = new Session({
  peerId: "123456789",
  server: { rendezvousUrl: "wss://rd.example.com/ws/id", key: "<id_ed25519.pub>" },
  settings: { imageQuality: "balanced", codec: "auto" },
});
const viewer = new Viewer(document.getElementById("screen")!, session);

session.on("password", ({ wrong }) => askPassword(wrong).then((p) => session.login(p)));
session.on("twoFactor", ({ wrong }) => askCode(wrong).then((c) => session.submitTwoFactor(c)));
session.on("waitingForApproval", () => showHint("Waiting for the remote user to accept"));
session.on("connected", ({ peer, rememberedHash }) => console.log("connected to", peer.hostname));
session.on("close", ({ reason, retryable }) => console.log("closed:", reason, retryable));

await session.connect();
```

### Options

`new Session(options: SessionOptions)`

| option | type | description |
|---|---|---|
| `server` | `ServerConfig` | required |
| `peerId` | `string` | required; device id, whitespace is removed |
| `rememberedHash` | `Uint8Array` | a stored `SHA256(password ‖ salt)` from an earlier login ("remember password"), tried before asking for a password |
| `myName` | `string` | shown to the remote user in the connection request (default `"Web client"`) |
| `myId` | `string` | our id as shown on the remote side (default `"web"`) |
| `settings` | `Partial<SessionSettings>` | initial settings, see below |
| `clientVersion` | `string` | version announced to the device, which enables features by version (default `CLIENT_VERSION`, currently `"1.4.3"`) |

The constructor throws when `peerId` is empty (`SessionError` with code
`bad-config`) or when `server.key` is not a valid key.

### Settings

`SessionSettings`, the same choices the desktop client offers. Defaults are
exported as `DEFAULT_SETTINGS`. Change them at any time with
`updateSettings(patch)`; while connected, what the device needs to know
(quality, codec, cursor, audio, clipboard, view-only, ...) is sent to it right away.

| setting | default | description |
|---|---|---|
| `imageQuality` | `"balanced"` | `"best"` (good image), `"balanced"`, `"low"` (optimize reaction time) or `"custom"` |
| `customQuality` | `50` | with `"custom"`: percent of the default bitrate, 10 to 100 (up to 2000 on own servers) |
| `customFps` | `30` | with `"custom"`: frame rate cap, 5 to 120 |
| `codec` | `"auto"` | preferred codec: `"auto"`, `"vp8"`, `"vp9"`, `"av1"`, `"h264"`, `"h265"` |
| `trueColor` | `false` | ask for 4:4:4 chroma when the codec and the browser support it |
| `showRemoteCursor` | `false` | draw the device's cursor at its reported position |
| `followRemoteCursor` | `false` | |
| `followRemoteWindow` | `false` | |
| `disableAudio` | `false` | |
| `disableClipboard` | `false` | |
| `lockAfterSessionEnd` | `false` | lock the remote screen when the session ends |
| `viewOnly` | `false` | no keyboard, mouse or clipboard |
| `showMyCursor` | `false` | in view-only mode, show our pointer to the remote user |
| `keyboardMode` | `"map"` | `"map"` (physical keys, the remote layout), `"translate"` (local layout) or `"legacy"`; Android and iOS devices always get legacy |
| `swapCtrlMeta` | `false` | swap Ctrl and Cmd/Win, e.g. a Mac controlling a Windows PC |

Only codecs that both the device can encode and this browser can decode are
used; `peer.codecs` lists them after login.

### Events

`session.on(type, listener)` returns a function that removes the listener. A
listener that throws is logged and does not affect the session.

| event | payload | description |
|---|---|---|
| `state` | `{ state }` | see [How a connection works](#how-a-connection-works) |
| `password` | `{ wrong }` | the device wants a password; answer with `login()`. `wrong` after a failed attempt |
| `twoFactor` | `{ wrong }` | the device wants a 2FA code; answer with `submitTwoFactor()` |
| `waitingForApproval` | `{}` | waiting for the remote user to click Accept (a password can still be entered meanwhile) |
| `connected` | `{ peer, rememberedHash }` | logged in. `rememberedHash` is the salted hash that worked, to store for next time if the user wants (`null` when no password was used) |
| `peer` | `{ peer }` | `PeerSummary` changed (displays, codecs) |
| `display` | `{ display, resolutions }` | current display geometry, also after a display switch |
| `cursorShape` | `{ id }` | the remote cursor changed shape |
| `cursorPosition` | `{ x, y }` | the remote cursor moved (remote screen coordinates) |
| `clipboard` | `{ text }` | the remote clipboard changed |
| `permission` | `{ name, enabled }` | the remote side changed a permission (`keyboard`, `clipboard`, `audio`, `file`, `restart`, `recording`, `blockInput`, `privacyMode`) |
| `message` | `{ type, title, text, link }` | a message box from the device (`type` contains `"error"` for errors) |
| `chat` | `{ text }` | a chat message from the remote user |
| `privacyMode` | `{ on, message }` | privacy mode state |
| `blockInput` | `{ on, message }` | block-user-input state |
| `stats` | `SessionStats` | once a second while connected: codec, 4:4:4, size, fps, kbps, decoded/received/dropped frames, round trip (`delayMs`) and the device's target bitrate |
| `audio` | `{ state }` | `"off"`, `"blocked"` (the browser waits for a user gesture, call `resumeAudio()`), `"playing"` or `"unsupported"` |
| `close` | `CloseInfo` | `{ reason, remote, retryable }`: who ended it, and whether reconnecting makes sense |

Decoded video frames are not delivered as events: they go to the frame sink
(see `setFrameSink`), which `Viewer` installs.

### Methods

Connection:

| method | description |
|---|---|
| `connect(): Promise<void>` | rendezvous, relay, handshake and login. Resolves once the session streams; rejects with a `SessionError` |
| `login(password): Promise<void>` | answers `password` |
| `submitTwoFactor(code)` | answers `twoFactor` |
| `close(reason?)` | ends the session and tells the device why |
| `updateSettings(patch)` | see [Settings](#settings) |

Display and device:

| method | description |
|---|---|
| `switchDisplay(index)` | show another monitor |
| `changeResolution(width, height, display?)` | change the remote resolution (`0, 0` restores the original one) |
| `refreshVideo()` | ask for a fresh key frame |
| `ctrlAltDel()`, `lockScreen()` | special keys |
| `setPrivacyMode(on, implKey?)`, `setBlockInput(on)` | where the device supports them (`peer.privacyModeSupported`; block input on Windows) |
| `selectWindowsSession(sid)` | switch the Windows session on multi-user hosts (`peer.windowsSessions`) |
| `restartRemote()` | restart the remote device |

Input (ignored unless `canControl` is true, i.e. connected, not view-only and
keyboard permission granted):

| method | description |
|---|---|
| `mouseMove(x, y)` | absolute pointer position in remote screen coordinates (the display's `x`/`y` offset included) |
| `mouseButton(button, down, x, y)` | `button`: `"left"`, `"right"`, `"middle"`, `"back"`, `"forward"` |
| `wheel(stepsX, stepsY)` | discrete wheel steps; positive `y` scrolls up |
| `trackpadScroll(dx, dy)` | smooth pixel scrolling; positive `y` scrolls up |
| `key(ev: KeyInput)` | `{ code, key, down, repeat?, capsLock?, numLock? }` from a `KeyboardEvent` |
| `releaseAllKeys()` | release every key we think is held (on blur) |
| `typeText(text)` | type text on the remote side (IME, on-screen keyboards) |
| `sendClipboard(text)` | put text on the remote clipboard (up to 4 MiB) |
| `pasteShortcut()` | press the remote side's paste shortcut: Cmd+V on macOS devices, Ctrl+V elsewhere (so Cmd+V on a Mac pastes on Windows too) |
| `sendChat(text)` | a chat message to the remote user |

Audio and frames:

| method | description |
|---|---|
| `resumeAudio()` | call from a user gesture when `audioState` is `"blocked"` |
| `setVolume(v)` | 0 to 1 |
| `setFrameSink(sink)` | receives each decoded `VideoFrame`; the sink owns the frame and must `close()` it. `Viewer` sets this |

### Properties

| property | description |
|---|---|
| `peerId` | the device id |
| `state` | `SessionState` |
| `settings` | current `SessionSettings` |
| `peer` | `PeerSummary` after login: `hostname`, `username`, `platform`, `os`, `version`, `displays`, `currentDisplay`, `resolutions`, `codecs`, `codecs444`, `privacyModeSupported`, `sasEnabled`, `windowsSessions`, `currentWindowsSession` |
| `display` | the current `DisplayRect` |
| `permission` | the permissions the remote side granted |
| `canControl` | keyboard and mouse input is allowed right now |
| `audioState` | see the `audio` event |
| `connection` | `{ rendezvousUrl, relayUrl, tls }`: the endpoints in use and whether the relay WebSocket is `wss://` |
| `closeInfo` | why it closed, once it has |

## Viewer

Renders a session into an element (a canvas plus a cursor overlay) and turns
input into remote input. It needs WebCodecs (`isWebCodecsAvailable()`).

```ts
const viewer = new Viewer(container, session, { scaleMode: "fit" });
viewer.on("files", ({ dataTransfer }) => uploadDropped(dataTransfer));
// later
viewer.destroy();
```

The container should have a size; the viewer fills it. It injects a small
stylesheet (`.rdweb-root`, `.rdweb-canvas`, ...) once per page.

### Options

| option | default | description |
|---|---|---|
| `scaleMode` | `"fit"` | `"fit"`, `"original"` (1:1; on touch screens a zoomed view) or `"stretch"` |
| `inputMode` | `"trackpad"` on touch-first devices, else `"mouse"` | `"mouse"`: the remote cursor follows the pointer. `"trackpad"`: the touch screen works like a laptop touchpad. `"touch"`: taps and drags happen where you touch |
| `zoomCursor` | `false` | scale the remote cursor with the view |
| `trackpadSpeed` | `1.4` | pointer speed in trackpad mode |

Touch gestures: in trackpad mode drag moves the pointer, tap clicks,
double-tap and drag drags, long press or two-finger tap right-clicks, two
fingers scroll and pinch zooms. In touch mode, tap clicks where you touch,
long press right-clicks, two fingers scroll and pinch zooms.

### Methods and events

| method | description |
|---|---|
| `getScaleMode()`, `setScaleMode(mode)` | |
| `getInputMode()`, `setInputMode(mode)` | |
| `setZoomCursor(on)` | |
| `getZoom()`, `resetZoom()` | pinch zoom (touch modes) |
| `focus()` | capture the keyboard |
| `showKeyboard()`, `hideKeyboard()` | the on-screen keyboard on touch devices |
| `enterFullscreen(el?)`, `exitFullscreen()` | fullscreen with keyboard lock where supported (Esc, Alt+Tab go to the device) |
| `screenshot(): Promise<Blob \| null>` | the current frame as PNG |
| `destroy()` | release input, remove the elements and the frame sink |

| event | payload | description |
|---|---|---|
| `zoom` | `{ zoom }` | pinch zoom changed |
| `focus` | `{ focused }` | keyboard capture changed |
| `clipboardBlocked` | `{ text }` | the remote clipboard changed but the browser did not let us write the local one; offer a Copy button |
| `files` | `{ dataTransfer }` | files were pasted (Ctrl/Cmd+V) or dropped onto the screen. Read a drop synchronously: its `DataTransfer` expires after the event |

Pasted text goes to the remote clipboard and the remote paste shortcut is
pressed (`pasteShortcut()`). `normalizeWheel(e)` is exported too: it splits
wheel events into notch steps and smooth touchpad deltas.

## FileTransferSession

The remote file system over its own connection (same login as a desktop
session; pass the `rememberedHash` of a desktop login to sign in silently).

```ts
import { FileTransferSession } from "rdweb";

const ft = new FileTransferSession({ peerId: "123456789", server });
ft.on("password", ({ wrong }) => askPassword(wrong).then((p) => ft.login(p)));
await ft.connect();

// "" is the remote user's home; on Windows "/" lists the drives
const dir = await ft.listDir(ft.homeDir, { showHidden: false });
for (const e of dir.entries) console.log(e.type, e.name, e.size, new Date(e.modified));
```

### Options

| option | default | description |
|---|---|---|
| `server`, `peerId`, `rememberedHash`, `myName`, `myId`, `clientVersion` | | as for `Session` |
| `initialDir` | `""` | folder listed first (empty: the remote user's home) |
| `showHidden` | `false` | include hidden entries in the first listing |
| `requestTimeoutMs` | `30000` | how long to wait for a listing or a file operation |
| `maxBlockSize` | 1 MiB | largest data block accepted, before and after zstd decompression (devices send at most 128 KiB) |
| `maxBufferedBytes` | 32 MiB | received data a download may hold that the consumer has not read yet |
| `sendBufferHighWater` | 1 MiB | uploads pause while the WebSocket send buffer holds more |

### Events

`state`, `password`, `twoFactor`, `waitingForApproval`, `peer`, `permission`,
`message` and `close` work as for `Session`. In addition:

| event | payload | description |
|---|---|---|
| `connected` | `{ peer, rememberedHash, home }` | logged in and the first listing arrived (`home` is `null` if the device sent none). `peer` has a `separator` (`"/"` or `"\\"`) |
| `progress` | `TransferProgress` | `{ jobId, direction, file, files, filesDone, skipped, bytes, totalBytes }` |
| `conflict` | `{ conflict, answer }` | an upload found an existing remote file; call `answer("overwrite" \| "skip" \| "overwriteAll" \| "skipAll")` once |
| `error` | `FileErrorEvent` | errors reported by the device or found locally, also for jobs whose promise rejects |

### Paths and listings

| member | description |
|---|---|
| `homeDir` | the folder listed first |
| `separator` | `"/"`, or `"\\"` on Windows |
| `joinPath(dir, name)` | joins with the remote separator (`"/"` + `"C:"` gives `C:\` on Windows) |
| `parentPath(path)` | the parent; on Windows a drive root's parent is the drive list `"/"` |
| `listDir(path, { showHidden? })` | `{ path, entries }`; each `RemoteEntry` has `name`, `type` (`dir`, `dirLink`, `drive`, `file`, `fileLink`, `unknown`), `size`, `modified` (ms since the epoch) and `hidden` |
| `mkdir(path)` | creates a folder with missing parents |
| `rename(path, newName)` | renames within the folder (no separators in `newName`) |
| `remove(path, { dir?, recursive?, onProgress? })` | removes a file, or a folder with `dir`; a non-empty folder needs `recursive` |

### Downloads

`download(remotePath, { showHidden?, signal?, onProgress? })` returns a
`Download` job for a file or a whole folder. The device sends the file list
first, then each file only after we ask for it, so the job is consumed file by
file:

```ts
// Into a folder the user picked (File System Access API).
const target = await showDirectoryPicker({ mode: "readwrite" });
await ft.download(ft.joinPath(ft.homeDir, "Documents"), { onProgress }).saveTo(async (file) => {
  const parts = file.relativePath.split("/"); // "Documents/sub/a.txt"
  let d = target;
  for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
  return (await d.getFileHandle(parts.at(-1)!, { create: true })).createWritable();
});

// Or one file at a time, any way you like.
const job = ft.download("/var/log");
for await (const file of job) {
  if (file.size > 100 << 20) continue; // never read: skipped
  for await (const chunk of file) consume(file.relativePath, chunk);
}
await job.done;

// Small files straight into a Blob.
const { blob } = await ft.downloadBlob(ft.joinPath(ft.homeDir, "notes.txt"), { maxBytes: 16 << 20 });
```

| `Download` | description |
|---|---|
| `files: Promise<TransferFileInfo[]>` | the file list, once the device sent it |
| `[Symbol.asyncIterator]` | yields an `IncomingFile` per file; leaving the loop early cancels the download |
| `saveTo(open)` | writes each file to the `WritableStream` that `open(file)` returns (return `null` to skip it) |
| `done: Promise<TransferResult>` | `{ jobId, direction, files, skipped, bytes, confirmed }`. Files are only requested as they are consumed, so awaiting `done` alone waits forever |
| `cancel()` | |

| `IncomingFile` | description |
|---|---|
| `index`, `name`, `relativePath`, `remotePath`, `size`, `modified` | `relativePath` is `/`-separated and relative to the downloaded item's parent folder, e.g. `Documents/sub/a.txt` |
| `[Symbol.asyncIterator]` | the data as `Uint8Array` chunks |
| `stream()` | the data as a pull-based `ReadableStream` |
| `blob(maxBytes?, type?)` | collects the file; fails with `too-large` beyond `maxBytes` |
| `skip()` | don't transfer this file (or drop the rest of it) |

`downloadBlob(path, { maxBytes = 64 MiB, type?, ... })` resolves with
`{ file, blob }` and fails with `not-a-file` for folders.

Handle each file before asking for the next one: a file that nobody started
reading by then is skipped. The protocol cannot pause a file midway, so a
consumer slower than the network fails the download with `overflow` once
`maxBufferedBytes` of unread data piled up.

### Uploads

`upload(files, remoteDir, options)` takes `File` objects (their
`webkitRelativePath` creates sub-folders) or `UploadItem`s
(`{ name, relativePath?, size?, lastModified?, data: Blob | ReadableStream }`;
`size` is required for streams).

```ts
ft.on("conflict", ({ conflict, answer }) =>
  answer(confirm(`Replace ${conflict.file.relativePath}?`) ? "overwrite" : "skip"),
);
const up = ft.upload(input.files!, ft.homeDir, { onProgress });
await up.done; // up.cancel() stops it and removes the partial remote file
```

| option | description |
|---|---|
| `overwrite` | `"ask"` (default: `onConflict`, else the `conflict` event listeners, else skip), `"overwrite"` or `"skip"` |
| `onConflict(c)` | returns (or resolves to) a `ConflictAnswer`; `c.identical` is true when size and date match |
| `resume` | continue an interrupted upload of the first file when the device still has the partial copy (devices 1.4.2+) |
| `signal`, `onProgress` | |

`Upload` has `files`, `done` and `cancel()`. `done` resolves with
`confirmed: false` when the device's acknowledgement did not arrive in time
(slow remote disk).

Transfers run one at a time, in the order they were started. Listings and
file operations are not queued behind them.

## TerminalSession

Remote shells (RustDesk's "Terminal", devices on RustDesk 1.4.1 or later):
PowerShell or cmd on Windows, the user's shell elsewhere. One connection
carries several shells, each identified by a terminal id you choose; terminal
0 opens with the session.

```ts
import { TerminalSession } from "rdweb";

const term = new TerminalSession({ peerId: "123456789", server, cols: 120, rows: 32, persistent: true });
term.on("password", ({ wrong }) => askPassword(wrong).then((p) => term.login(p)));
term.on("data", ({ terminalId, data }) => xterms[terminalId].write(data));
term.on("exit", ({ terminalId, code }) => console.log(`shell ${terminalId} exited with ${code}`));
await term.connect();                 // opens terminal 0

term.write("ls -la\r");               // to terminal 0
await term.openTerminal(1, 120, 32);  // a second shell (a tab)
term.resize(140, 40, 1);
term.closeTerminal(1);
```

### Options

| option | default | description |
|---|---|---|
| `server`, `peerId`, `rememberedHash`, `myName`, `myId`, `clientVersion` | | as for `Session` |
| `cols`, `rows` | `80`, `24` | size of terminal 0 in character cells |
| `persistent` | `false` | ask the device to keep the shells running when the connection drops |
| `serviceId` | | the `serviceId` of an earlier session, to reattach to its shells |

### Events

`state`, `password`, `twoFactor`, `waitingForApproval` and `close` as for
`Session`, plus:

| event | payload | description |
|---|---|---|
| `connected` | `{ peer, rememberedHash }` | terminal 0 is open. `peer` is a `TerminalPeer` (`hostname`, `username`, `platform`, `os`, `version`) |
| `data` | `{ terminalId, data, replay }` | shell output as UTF-8 bytes (a chunk may split a character). `replay` marks the buffered output of a reattached shell: terminal emulators should not answer queries found in it |
| `exit` | `{ terminalId, code }` | a shell exited; the session closes when the last one did |

### Methods and properties

| member | description |
|---|---|
| `connect()` | connects, logs in and opens terminal 0 |
| `login(password)`, `submitTwoFactor(code)` | |
| `openTerminal(id, cols, rows)` | opens another shell on the same connection; ids are unique per session |
| `write(data, terminalId = 0)` | keystrokes or pasted text (string or bytes) |
| `resize(cols, rows, terminalId = 0)` | |
| `closeTerminal(terminalId)` | ends one shell; the session stays up |
| `close(reason?, { keepShells? })` | ends the session; the shells end too unless `keepShells` (a persistent service then keeps them for a later reattach) |
| `closeService(reason?)` | ends every shell of the service, open and restorable, and the session |
| `terminals` | ids of the open shells |
| `serviceId` | the device's id for this set of shells; pass it as `serviceId` to reattach |
| `restorable` | after reattaching: the other shells of the service; open them with `openTerminal(id, ...)` to get them back |
| `peer`, `state`, `closeInfo` | |

### Keeping shells across disconnects

With `persistent: true` the device keeps the shells when the connection
drops. Store `serviceId` after `connect()`. A later session with the same
`serviceId` gets terminal 0 back with its recent output (`replay: true`);
`restorable` lists the other shells. The device still asks for its own login
on every connection: a service id alone opens nothing.

```ts
const again = new TerminalSession({ peerId, server, persistent: true, serviceId: saved });
await again.connect();
for (const id of again.restorable) await again.openTerminal(id, cols, rows);
```

The React terminal (`mode="terminal"`) does all of this, including
reconnecting on its own after a drop; see [react.md](react.md#terminal-mode).

## checkServer

Checks a server the way a connection would use it, without contacting any
device. The standalone app's "Check" button runs it.

```ts
import { checkServer } from "rdweb";

const check = await checkServer(server, { peerId: "123456789", timeoutMs: 8000, signal });
for (const step of check.steps) console.log(step.id, step.status, step.ms, step.code, step.detail);
// rendezvous ok 41 / key skip / relay ok 38 / device fail offline
```

`checkServer(server, { peerId?, timeoutMs?, keyWaitMs?, signal? })` resolves
with `{ ok, steps, rendezvousUrl, relayUrl }`; `ok` is true when no step
failed. It rejects only when `signal` aborts.

| option | default | description |
|---|---|---|
| `peerId` | | also ask hbbs whether this device is online |
| `timeoutMs` | `8000` | per connection and per answer |
| `keyWaitMs` | `1000` | how long to wait for hbbs' signed key |
| `signal` | | `AbortSignal` |

Steps, in this order, each `{ id, status: "ok" | "fail" | "skip", ms?, detail?, code? }`:

| step | what it does |
|---|---|
| `rendezvous` | opens the hbbs WebSocket (`rendezvousUrl`) and times it |
| `key` | waits for hbbs' `KeyExchange` (its key signed with the server's Ed25519 key) and verifies it with `server.key`. See below |
| `relay` | opens the hbbr WebSocket (`relayUrl("")`, or `relayUrlNextTo`) and closes it without a request |
| `device` | only with `peerId`: an `OnlineRequest` that hbbs answers from its registration table |

Failure codes (`ServerCheckCode`): `unreachable` (the WebSocket could not be
opened: DNS, TLS certificate, proxy, port), `timeout`, `key-mismatch`,
`bad-config` (malformed URL or key, or `ws://` from an HTTPS page),
`offline` (hbbs does not list the device as online).

**About the key step.** hbbs sends its signed `KeyExchange` unsolicited as the
first message of a TCP connection; upstream hbbs never sends it over
WebSocket, so against upstream hbbs the key step reports `skip` (a wrong key
then shows up as `key-mismatch` when connecting to a device). The fork
[bropines/rustdesk-server](https://github.com/bropines/rustdesk-server) has an
opt-in `WS_KEY_EXCHANGE=Y` (or `--ws-key-exchange Y`) that makes hbbs send it
on WebSocket connections too; with it the step reports `ok` or `key-mismatch`.
It is off by default.

The check never sends a punch-hole or relay request, so no device is
contacted or notified.

## Errors

### SessionError

`connect()` of every session type rejects with a `SessionError`
(`error.code`, `error.message`). `close.retryable` is true for `network`,
`unreachable`, `timeout` and `offline`.

| code | meaning |
|---|---|
| `bad-config` | empty device id |
| `unreachable` | the WebSocket to the ID server or the relay could not be opened (DNS, TLS certificate, proxy, a port a browser cannot use) |
| `network` | the connection broke |
| `timeout` | the device did not answer in time (or, for terminals, did not open a shell) |
| `offline` | hbbs reports the device offline |
| `not-found` | no device with this id is registered |
| `key-mismatch` | hbbs was given a different server key than its own |
| `login-required` | the server requires a signed-in client (`token`) |
| `refused` | the server or device refused, e.g. licence limits, or a device that cannot open a terminal |
| `unverified-peer` | hbbs did not vouch for the device's key, so the connection was refused |
| `handshake` | the device's identity or the encrypted stream did not verify |
| `login` | the device refused the login for another reason (the message says which) |
| `permission-denied` | file transfer or terminal is not allowed on the device (files and terminal sessions) |
| `remote-closed` | the device ended the session during login |
| `closed` | `close()` was called while connecting |
| `state` | a method was called in the wrong state, e.g. `connect()` twice or `login()` without a `password` event |
| `aborted`, `internal` | |

### FileTransferError

File operations and transfer jobs reject with a `FileTransferError`. Besides
`code` it carries `jobId`, `fileIndex`, `path` and the device's own
`remoteMessage` when the error came from the device.

| code | meaning |
|---|---|
| `permission-denied` | the device refused access (OS permission, file transfer disabled) |
| `not-found`, `exists`, `not-empty` | |
| `too-many-files` | the device's limit of files per transfer |
| `invalid-name` | a path or name is not acceptable (traversal, absolute paths, separators in a name) |
| `one-way` | the device only allows transfers towards us |
| `cancelled`, `timeout`, `closed` | |
| `protocol`, `oversize-block`, `decompress` | the device sent data that breaks the protocol or the limits |
| `overflow` | the consumer read more slowly than the data arrived (see [Downloads](#downloads)) |
| `too-large` | more data than allowed (`maxBytes`) |
| `not-a-file` | `downloadBlob` on a folder |
| `source` | reading a local upload source failed |
| `remote` | any other error from the device; see `remoteMessage` |

## Other exports

| export | description |
|---|---|
| `probeCodecs(): Promise<CodecSupport>` | which codecs this browser decodes (`decode`, and `decode444` for 4:4:4); probed once per page |
| `isWebCodecsAvailable()` | `VideoDecoder` exists (needed for `Session` video and `Viewer`) |
| `ALL_CODECS` | `["vp9", "av1", "h264", "h265", "vp8"]` |
| `isAudioDecodingAvailable()` | audio can be played (WebCodecs Opus, or the WebAssembly Opus decoder as a fallback) |
| `parseServerKey(key)` | validates a server key, returns its 32 bytes, throws otherwise |
| `encodeBase64`, `decodeBase64` | for storing remembered hashes |
| `normalizeWheel(e)` | wheel deltas as `{ dx, dy, smooth }` |
| `MOUSE_BUTTON`, `MOUSE_TYPE` | wire constants of mouse events |
| `DEFAULT_SETTINGS` | see [Settings](#settings) |
| `CLIENT_VERSION` | the RustDesk version announced to devices |
| `RDWEB_VERSION` | this library's version |

All option, event and result types are exported as TypeScript types (for
example `SessionOptions`, `SessionEventMap`, `PeerSummary`, `SessionStats`,
`FileTransferOptions`, `TransferProgress`, `TerminalOptions`, `ServerCheck`).

## Running outside a browser

The sessions need only `WebSocket`, `crypto.subtle` and, for video,
WebCodecs. Node 22 and later has the first two, so `Session`,
`FileTransferSession`, `TerminalSession` and `checkServer` connect from Node
too (video frames arrive but are not decoded without WebCodecs).
[`test/e2e-node.mjs`](../test/e2e-node.mjs) runs a real session from Node
against a live server and device.
