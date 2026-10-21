# Security model

rdweb connects a browser to a RustDesk device through the server's relay. The
server is trusted to vouch for devices, and nothing else: the session is
encrypted end to end between the browser and the device, and the relay and
the reverse proxy forward ciphertext. Anything that does not verify ends the
connection; there is no fallback to an unauthenticated one.

Contents:

- [Trust chain](#trust-chain)
- [Session encryption](#session-encryption)
- [Login](#login)
- [What TLS covers](#what-tls-covers)
- [No fallback](#no-fallback)
- [Remembered passwords](#remembered-passwords)
- [Other data in the browser](#other-data-in-the-browser)
- [The standalone page](#the-standalone-page)

## Trust chain

The only thing configured out of band is the server's Ed25519 public key, the
contents of `id_ed25519.pub`. Everything else is checked against it.

1. **The server vouches for the device.** The browser asks hbbs for the
   device (a punch-hole request with the server key and, if set, a client
   token). hbbs answers with a relay ticket and the device's long-term
   Ed25519 key, signed with the server key as `IdPk { id, pk }`. rdweb checks
   the signature with the configured key and that the signed id is the
   device it asked for.
2. **The device proves it holds that key.** Over the relay, the device sends
   `IdPk { id, pk }` with a fresh Curve25519 key for this session, signed with
   its long-term key. rdweb checks this signature with the key from step 1,
   and the id again.
3. **A session key for this device only.** rdweb generates a random 32-byte
   key and seals it with `crypto_box` (Curve25519, XSalsa20-Poly1305) from a
   fresh key pair of its own to the device's session key. Only the device that
   holds the matching secret key can open it. rdweb's ephemeral secret key is
   wiped right after.

So a relay, a proxy or a network attacker cannot impersonate the device
without the server's signing key, and a server key that was swapped in transit
does not match the configured one.

## Session encryption

After the key exchange every message in both directions is sealed with
`crypto_secretbox` (XSalsa20-Poly1305) under the session key, with a separate
counter per direction as the nonce. A message that does not decrypt (tampered,
replayed, reordered or dropped) ends the session. The key is wiped when the
session closes.

This covers everything: video, audio, input, clipboard, chat, files and
terminal data. File transfer and terminal sessions are separate connections
and go through the same steps with their own keys.

## Login

The device sends a salt and a one-time challenge. rdweb answers with

```
proof = SHA256( SHA256(password ‖ salt) ‖ challenge )
```

inside the encrypted session, as the desktop client does. The password
itself is never sent. 2FA codes also travel inside the encrypted session. A
device without a password known to the user can be reached by someone on the
device clicking Accept; rdweb asks for the password at the same time.

## What TLS covers

The WebSocket connections to the reverse proxy are `wss://` (browsers require
TLS on HTTPS pages anyway). TLS protects what is outside the end-to-end
encryption from the network:

- the rendezvous request: which device id is asked for, the server key and
  the client token,
- the relay pairing, and the size and timing of the encrypted session
  traffic.

The proxy and the relay terminate or forward this traffic, so they see the
device id, IP addresses, timing and volume, but not the content. The
connection details dialog of the React UI shows whether the relay connection
uses TLS ("Relay, WebSocket over TLS").

## No fallback

rdweb ends the connection rather than continuing with less security:

| situation | result |
|---|---|
| missing or malformed server key | the session cannot even be created |
| hbbs reports a different server key | `key-mismatch` |
| hbbs sends no signed device key | `unverified-peer` |
| a signature or id does not verify | `handshake` |
| a message does not decrypt | the session ends |

There is no P2P path either: browsers cannot accept direct connections, so
rdweb always asks for the relay (it reports a symmetric NAT and forces the
relay), and ignores answers that offer a direct connection.

## Remembered passwords

"Remember password" stores what the desktop client stores: the salted hash
`SHA256(password ‖ salt)`, not the password.

- It is kept in the browser's localStorage under
  `<storageKey>.pw.<first 16 characters of the server key>.<device id>`
  (base64), so it belongs to one device on one server.
- It logs in to that device without revealing the password, until the
  device's password changes. Treat it like a password for that device: anyone
  who can read this browser profile's storage can use it.
- In the React UI, a hash the device rejects is removed, and "Forget saved
  password" in the toolbar removes it on demand; `clearStoredData()` removes
  all of them.
- Hosts with accounts can keep the hash server side instead (`onRemembered`,
  `credentials.rememberedHash`), as RD Panel does in the user's address book.
- A plain password passed by the host (`credentials.password`) is tried once
  and is not stored. Passwords never appear in URLs.

## Other data in the browser

- Settings, the toolbar layout and recent devices (device ids and host names).
- The file manager's local folder: a File System Access handle in IndexedDB.
  The browser may ask for permission again before it can be used
  ("Reconnect folder").
- Terminal: settings, and the service ids of kept shells (in localStorage,
  or wherever a host's `ShellStore` puts them). A service id lets a session
  reattach to running shells, but the device still requires its own login on
  every connection.

See [react.md](react.md#what-is-stored-in-the-browser) for the exact keys.

## The standalone page

<https://bropines.github.io/rdweb/> is a static page without a backend or
analytics. Its Content Security Policy allows network requests to other sites
only as WebSockets, which the app opens only to the servers the user added,
and it sends no referrer. The service worker caches the app's own files and
never sees WebSocket traffic. See [standalone-app.md](standalone-app.md#privacy).
