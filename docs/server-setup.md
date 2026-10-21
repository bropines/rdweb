# Server setup

rdweb talks to the usual RustDesk server programs, hbbs (ID/rendezvous) and
hbbr (relay), over WebSocket. Nothing else runs on the server: no extra
service, no plugin. This page explains what the server must expose for
browsers.

Contents:

- [Overview](#overview)
- [Reverse proxy](#reverse-proxy)
- [The server key](#the-server-key)
- [The relay](#the-relay)
- [Servers that require login](#servers-that-require-login)
- [RD Panel](#rd-panel)
- [Checking the setup](#checking-the-setup)
- [Troubleshooting](#troubleshooting)

## Overview

```
browser ──wss://rd.example.com/ws/id────▶ reverse proxy ──▶ hbbs :21118 (WebSocket)
browser ──wss://rd.example.com/ws/relay─▶ reverse proxy ──▶ hbbr :21119 (WebSocket)
device  ──────────── TCP/UDP 21116, 21117 as usual ──────▶ hbbs, hbbr
```

hbbs and hbbr listen for WebSocket clients on their usual port plus 2: hbbs on
21118, hbbr on 21119. Browsers on an HTTPS page can open only `wss://` URLs
with a valid certificate for the host name, so the WebSocket ports go behind a
TLS reverse proxy:

| path | upstream | description |
|---|---|---|
| `wss://<host>/ws/id` | hbbs `21118` | rendezvous |
| `wss://<host>/ws/relay` | hbbr `21119` | relay |

The paths are the convention that rdweb's defaults and the standalone app
assume (a host name `rd.example.com` becomes these two URLs). Any other URL
works with the library if you pass it in [`ServerConfig`](library.md#serverconfig).

Devices keep using the normal ports; nothing changes for them. Browsers always
go through the relay, so their traffic goes through your server (see
[security.md](security.md)).

## Reverse proxy

### nginx or Angie

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name rd.example.com;
    ssl_certificate     /etc/ssl/rd.example.com/fullchain.pem;
    ssl_certificate_key /etc/ssl/rd.example.com/privkey.pem;

    location /ws/id {
        proxy_pass http://127.0.0.1:21118;
        include ws.conf;
    }
    location /ws/relay {
        proxy_pass http://127.0.0.1:21119;
        include ws.conf;
    }
}
```

```nginx
# ws.conf
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_read_timeout 1h;
proxy_send_timeout 1h;
```

- The `Upgrade` and `Connection` headers turn the request into a WebSocket.
- hbbs and hbbr take the client address from `X-Real-IP` /
  `X-Forwarded-For`. Set both to the real client address (overwrite, do not
  append) so the logs and IP blocklists see real addresses, and do not expose
  21118/21119 to the internet: only the proxy needs them.
- Long timeouts keep idle sessions open.

### Caddy

```caddy
rd.example.com {
    reverse_proxy /ws/id    127.0.0.1:21118
    reverse_proxy /ws/relay 127.0.0.1:21119
}
```

Caddy gets the certificate and handles the WebSocket upgrade by itself.

### hbbs and hbbr in Docker

If hbbs and hbbr run in containers, publish 21118 and 21119 to the proxy (or
put the proxy in the same network) in addition to the usual ports. Upstream
hbbs and hbbr serve WebSocket on these ports; there is nothing to turn on.

## The server key

hbbs signs the keys of registered devices with its Ed25519 key pair
(`id_ed25519` and `id_ed25519.pub`, created next to hbbs on the first start).
rdweb needs the public key, the contents of `id_ed25519.pub`: it is the "Key"
in the RustDesk client's ID/Relay server settings and on RD Panel's Server
page.

The key is required. rdweb sends it with each request, like RustDesk clients
do (hbbs answers a key that does not match its own with `key-mismatch`), and
verifies with it that hbbs vouches for the device's key before anything is
sent to the device. If hbbs does not sign device keys, rdweb refuses to
connect (`unverified-peer`).

## The relay

When a browser connects, hbbs tells the device which relay to meet it at (a
TCP address from hbbs' relay list, `-r` or `RELAY`). The browser cannot use
that address; it joins the relay **next to hbbs**, `/ws/relay` on the same host
as `/ws/id`, or the relay URL you configured. Both must end up on the same
hbbr:

- **Single host** (hbbs and hbbr on one machine, one relay): works as is.
- **Several relays**: make sure hbbs hands browser connections the relay that
  is behind your `/ws/relay`. RD Panel's image does this with
  `WS_RELAY_SERVERS`; with plain hbbs, use a single relay.
- **Every relay has its own TLS proxy**: the library can derive the relay URL
  from what hbbs announces with `relayUrl: announcedRelayUrl`
  (`relay.example.com:21117` becomes `wss://relay.example.com/ws/relay`).

In the standalone app, the server's "Relay" field sets a fixed relay URL.

## Servers that require login

hbbs started with `MUST_LOGIN=Y` accepts connection requests only with a valid
client token. The library sends one if you pass `token` in `ServerConfig`;
without it, connecting fails with `login-required`. RD Panel's web client gets
a short-lived token for the signed-in user automatically. The standalone app
has no token, so it cannot connect through such servers.

## RD Panel

[RD Panel](https://github.com/bropines/rdpanel) (an admin panel for RustDesk
servers, shipped in one image with hbbs and hbbr) has rdweb built in as its
web client at `/connect`. It serves `/ws/id` and `/ws/relay` itself (so a
reverse proxy that forwards everything to the panel is enough), hands the
browser the key and, with `MUST_LOGIN=Y`, a login token, keeps remembered
passwords in the user's address book and kept terminal shells in the
account, and applies its connection rules to browser sessions. See its
[web client documentation](https://github.com/bropines/rdpanel/blob/main/docs/web-client.md).

A standalone app user can add an RD Panel server by pasting the config string
from the panel's Server page.

## Checking the setup

The standalone app's **Check** button, or [`checkServer`](library.md#checkserver)
in code, tests what a browser needs without contacting any device:

1. the ID server WebSocket (`/ws/id`) opens,
2. the server key (see below),
3. the relay WebSocket (`/ws/relay`) opens,
4. optionally, hbbs lists a given device as online.

hbbs sends its signed key (`KeyExchange`) at the start of TCP connections
only; upstream hbbs never sends it over WebSocket, so the key step is
reported as skipped. hbbs from
[bropines/rustdesk-server](https://github.com/bropines/rustdesk-server) sends it
on WebSocket connections too when started with `WS_KEY_EXCHANGE=Y` (or
`--ws-key-exchange Y`). The option is opt-in and off by default; with it the
check verifies the configured key against the server. Without it, a wrong key
shows up as `key-mismatch` when connecting to a device.

From a shell, a WebSocket handshake through the proxy should answer
`101 Switching Protocols`:

```sh
curl -si --max-time 3 --http1.1 -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  https://rd.example.com/ws/id | head -1
```

## Troubleshooting

| error (code) | likely cause |
|---|---|
| `unreachable` | the browser could not open the WebSocket: DNS, no or invalid certificate, the proxy does not forward `/ws/id` or `/ws/relay`, an IP address or a RustDesk port in the address |
| `key-mismatch` | the configured key is not this server's `id_ed25519.pub` |
| `unverified-peer` | hbbs did not send a signed key for the device (it has no key pair) |
| `offline`, `not-found` | the device is not online on this server, or is registered on another server or with another key |
| `timeout` | the device did not answer: it is off, cannot reach the relay, or hbbs handed it a relay the browser cannot meet (see [The relay](#the-relay)) |
| `login-required` | hbbs runs with `MUST_LOGIN=Y`; pass a `token` |
| `handshake` | the device's identity did not verify: wrong key, or a device that is not the one with this id |
