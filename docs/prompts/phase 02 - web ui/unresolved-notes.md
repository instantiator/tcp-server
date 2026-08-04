# Phase 02 — unresolved notes

Things phase 02 has left open. Not a backlog of features: this is for the
findings that would otherwise be lost — a deliberate compromise, a constraint
imposed from outside, a decision that can only be taken once something else
exists.

Every prompt in this phase ends with a directive to add to this file. A prompt
that finishes with nothing to add says so in its plan, rather than leaving the
reader to wonder whether it was checked.

## How to use it

**Work that a later prompt will do** does not belong here. Write it into that
prompt, so whoever picks it up meets it in the place they are already reading.
Add a line to [Carried into a later prompt](#carried-into-a-later-prompt) so it
is visible from here too.

**Work whose trigger is a condition, not a date** — an upstream project adding
a feature, a library dropping a peer constraint, a number crossing a threshold —
needs an entry here _and_ a memory, because nothing in this repo will ever
prompt someone to re-check it. State the condition in a form that can be tested,
not "revisit later".

**Resolve an entry by deleting it**, in the change that resolves it. An entry
kept for the record is an entry nobody trusts is current.

## Open

### Vite's development server is exposed to the local network

**Raised by:** 002.03 · **Condition to revisit:** a tighter bind becomes possible

`--dev-web` puts nginx in a container in front of `vite dev` on the host,
reaching it through `host.docker.internal`. That arrives on the host's bridge
interface, not on loopback, so `vite.config.ts` sets `server.host: true` and the
development port is open to the LAN.

Vite's own `allowedHosts` still refuses any request whose `Host` header isn't
localhost, so a scan of the port gets a refusal rather than source code. That is
a mitigation, not a fix. The port is open on whatever network the machine is on.

Binding only to the Docker bridge address would be tighter, and is not portable
across Docker Desktop and Linux — which is why it wasn't done. Worth revisiting
if a stable way to name that interface appears.

### A trusted certificate needs a manual compose override

**Raised by:** 002.03 · **Condition to revisit:** first-run friction is reported

`tcp-web` generates a self-signed certificate at startup, so a first run needs no
setup, at the cost of a browser warning. [mkcert](../../web-client.md#a-trusted-certificate-with-mkcert)
removes the warning, but wiring it in means the reader adding a `volumes:` entry
by hand — the one step in that guide that isn't copy-and-paste.

It was left manual deliberately: a committed bind mount pointing at a directory
most people won't have is its own failure mode. If the warning turns out to bite
often enough, the answer is probably a `docker-compose.local-certs.yml` overlay
and a `--certs` flag, matching `--dev-ports` and `--dev-web`.

### HTTP/2 in development depends on two upstream gaps

**Raised by:** 002.03 · **Condition to revisit:** either gap closes

The `--dev-web` overlay exists only because of two things neither of which is
ours:

- **Vite's development server has no HTTP/2.** If it gains one, the overlay
  becomes optional for anyone who doesn't also want the same-origin `/api`.
- **nginx does not implement RFC 8441** (WebSockets over HTTP/2), so the HMR
  socket rides a separate HTTP/1.1 connection. It works, via a browser
  fallback, but it means a browser that ever drops that fallback breaks HMR
  through the proxy.

Both are recorded in the memory `project-web-http2-upstream-gaps`, because
nothing in this repository will surface them on its own.

## Carried into a later prompt

| Note                                                                                                                                      | Raised by | Goes to  |
| ----------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------- |
| End-to-end test that more than six simultaneous event streams work — 002.03 proved the transport, not the streams                         | 002.03    | `005.02` |
| `tcp-web` is handed the confidential OIDC client as a stopgap; it needs the public PKCE one, and `https` redirect URIs from `TCP_WEB_URL` | 002.03    | `004.01` |
| `enableCors()` stays unwired — the proxy settles it; document the CDN fallback rather than configuring one                                | 002.03    | `002.04` |
| A catch-all route: nginx returns the app document for any deep link, so an unknown path currently renders blank rather than a 404         | 002.03    | `003.02` |
| The browser tier drives the deployment over https with no local-server fallback, and runs inside CI's `api-test` job                      | 002.03    | `009.01` |
