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

### The consultations list is an approximation

**Raised by:** 002.04 · **Condition to revisit:** a `PendingConsultation` controller, or a consultation audit entity, exists

`GET /api/assignment?companyId=X&taskId=null&mode=consultee` lists consultee
assignments, not pending consultations. Every consulting agent works an orphan
consultee-mode assignment, so a consultation that has started appears — but one
that has been _requested_ and not yet picked up has no assignment at all, and is
invisible.

That is acceptable for the MVP list and is why 007.01 must not present it as
complete. When either a `PendingConsultation` controller or a consultation-level
audit entity exists, both the query and 007.01's wording change together.

### Every agent state change now reaches every subscriber of that company's stream

**Raised by:** 002.04 · **Condition to revisit:** the live view is reported as noisy, or one company routinely runs enough concurrent agents for the stream to be the bottleneck

Before 002.04 the company channel carried only `company` and `task` rows —
`CompanyEventService`'s comment said agent and assignment rows were filtered out
deliberately, to protect the roster TUI from volume. Widening the predicate to
five entities removed that protection: an agent's every status transition now
fans out to every open company stream.

No filtering, sampling or coalescing was added, because there is no measurement
yet to size it against and a filter chosen blind is a filter that hides the wrong
rows. Recorded in the memory `project-company-stream-volume`, because nothing in
this repository will surface it on its own.

### A 403 confirms that a company, task or agent exists

**Raised by:** 002.05 · **Condition to revisit:** id enumeration becomes a
realistic threat — a public deployment, or ids that are guessable rather than
UUIDs

Membership refusals are `403` everywhere, and a `404` means the handle names
nothing. That is deliberate: collapsing both into `404` would make every genuine
permissions problem look like a missing record, which is precisely the debugging
confusion ADR-011's amendment warns about. The cost is that a caller can learn
whether an id exists by the code they get back.

With v4 UUIDs and a private deployment that is not worth trading legibility for.
It stops being true if ids become enumerable or the deployment becomes public.

### `TCP_ADMIN_IDENTIFIERS` is a flat list in the environment

**Raised by:** 002.05 · **Condition to revisit:** permission groups exist (the
work carried into `010.01`)

"System administrator" had to mean something before `?all=true` and the
`/api/system` routes could be gated, and permission groups do not exist yet. A
comma-separated list of `sub` claims and email addresses is the interim answer:
fail-closed by default, written by the Zitadel bootstrap for local development,
set by hand against an external provider.

Its limits are real — changing it needs a restart, it is invisible from the API,
and it cannot express anything finer than "everything". It should be replaced by
whatever the permission-flag work builds, not extended.

### Membership matching trusts the token's `email` claim unconditionally

**Raised by:** 002.05 · **Condition to revisit:** an identity provider is used
whose users can set their own email address without verification — anything
other than the bundled Zitadel with its default policy

A `CompanyUser` row may be keyed by an OIDC `sub` **or** an email address, and
enforcement matches on both — ADR-011 requires it, because matching on `sub`
alone denies email-keyed members silently. The cost is that the `email` claim is
now an access-granting identifier: a provider that will mint a token carrying an
arbitrary, unverified `email` hands the bearer every email-keyed membership for
that address.

`email_verified` is not checked. Requiring it would close this, and would break
every email-keyed membership if a provider omits the claim — which is why it was
not changed blind at the end of 002.05. Before trusting a new provider, confirm
what it puts in `email` and `email_verified`, and gate on the latter if it is
reliably present. Recorded in the memory `project-membership-enforcement`.

### `POST /api/model/check` lets any authenticated caller reach an arbitrary URL

**Raised by:** 002.05 · **Condition to revisit:** tcp-server is deployed
somewhere with network access worth abusing — a cloud environment, or a network
with internal services on it

The model-compatibility probe names no company, so membership enforcement has
nothing to scope it by; it is annotated `@NoCompanyScope` and reachable by any
authenticated caller. It takes a `baseUrl` in its body and connects to it, which
makes it a server-side request forgery primitive: the caller chooses the
destination and learns something from the response.

Out of scope for 002.05, which was about company scoping, and harmless on a
laptop where the only reachable network is the developer's own. Fixing it means
an allow-list of destinations or making the route administrator-only. Recorded
in the memory `project-model-check-ssrf`, because nothing in this repository will
surface it on its own.

## Carried into a later prompt

| Note                                                                                                                                         | Raised by | Goes to  |
| -------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------- |
| End-to-end test that more than six simultaneous event streams work — 002.03 proved the transport, not the streams                            | 002.03    | `005.02` |
| `tcp-web` is handed the confidential OIDC client as a stopgap; it needs the public PKCE one, and `https` redirect URIs from `TCP_WEB_URL`    | 002.03    | `004.01` |
| A catch-all route: nginx returns the app document for any deep link, so an unknown path currently renders blank rather than a 404            | 002.03    | `003.02` |
| The browser tier drives the deployment over https with no local-server fallback, and runs inside CI's `api-test` job                         | 002.03    | `009.01` |
| Regenerate the client after 002.04: `GET /api/company` (`?all`, `stats`), `GET /api/assignment` (`?mode`), and four summary types changed    | 002.04    | `005.01` |
| The stat field names: `stats.activeAgents`, `stats.tasksByStatus` (zero-filled per status) and `stats.openEnquiries`, returned with the list | 002.04    | `006.01` |
| The company stream's five `payload.entity` values, the priming order, the summary shapes, and the exact consultations query                  | 002.04    | `007.01` |
| Live `agent` rows carry no summary — only primed ones do; render from priming and patch by `agentId`                                         | 002.04    | `007.01` |
| Enquiries stream open and close only — no per-message event, so a reply in progress is invisible until it closes                             | 002.04    | `007.01` |
| Memberships come from the scoped `GET /api/company`; 002.04 added to this prompt's **Needs first**                                           | 002.04    | `008.06` |
| SSE streams now refuse a non-member with `403` at connect — a permanent failure the backoff must not retry forever                           | 002.05    | `005.02` |
| `?all=true` is administrator-only; a `403` in the overview is a real error, not an empty state                                               | 002.05    | `006.01` |
| The memberships dialog is authoritative — membership _is_ the access control, so the list is exactly what the user can reach                 | 002.05    | `008.06` |
| The ADR-011 **permission flags** (migration, defaults, `@RequirePermission`, and the UI to set them) — 002.05 enforced membership only       | 002.05    | `010.01` |
| ADR-011's status wording: membership is enforced, flags are not; `route-audit.spec.ts` must stay green and cover every controller            | 002.05    | `009.03` |
