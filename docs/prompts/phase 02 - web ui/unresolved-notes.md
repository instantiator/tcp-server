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

### `base.css` styles React Aria through its default class names

**Raised by:** 003.01 · **Condition to revisit:** a `react-aria-components`
upgrade renames a default class, or deprecates a component the way 1.20
deprecated `Radio`

React Aria ships no styling, so `src/styles/base.css` carries the minimum a
control needs to be usable — a radio indicator, a selected state and a focus
ring — selected by `.react-aria-RadioButton`, `.react-aria-RadioGroup` and
`.react-aria-Button`. Those names are the library's `defaultClassName` values,
a convention rather than a documented API, and the surface is demonstrably
moving: 1.20 deprecates `Radio` in favour of `RadioField` + `RadioButton`, which
this prompt had to adopt mid-implementation.

Two things make the failure quiet. Passing `className` to a React Aria
component **replaces** the default rather than adding to it (`computedClassName
?? defaultClassName`), so a component that sets its own class silently loses
every rule unless it repeats the library's name — `ThemeControl` does. And a
renamed class breaks nothing that any test can see in jsdom: the `data-*`
attributes are still emitted, so only the browser tier's computed-style
assertions would notice. Recorded in the memory `project-react-aria-class-names`.

### The theme storage key is written in three places

**Raised by:** 003.01 · **Condition to revisit:** a build step that can inject a
shared constant into the entry document becomes worth its cost

`THEME_STORAGE_KEY` is declared in `src/theme/storage.ts`, duplicated in the
pre-paint script in `index.html` (which must run before the bundle loads and so
cannot import it), and now repeated a third time in
`test/browser/app-shell.spec.ts`, which seeds a theme through `localStorage` and
cannot import from `src/`. The doc comment on the constant names all three; that
comment is the only thing holding them together.

### A component stylesheet with an empty rule body cannot space its own content

**Raised by:** 003.01 · **Condition to revisit:** the first theme is written,
which is when the empty rule bodies get filled

ADR-026's convention means `LandingPage.css` and `ThemeControl.css` ship real
class names and no declarations, which is the intended trade. The visible
consequence is that the two radio groups on the landing page sit flush against
each other, with the "Colour mode" label directly beneath the last palette
option — the grouping is unambiguous to a screen reader, which reads the
`radiogroup` name, and merely cramped to a sighted reader.

This is a compromise taken knowingly, not a defect: ADR-020 defers visual design
entirely, and the alternative is putting layout values in `base.css`, where they
would apply to every page and be much harder to undo. Nothing needs doing until
the themes are written.

### The not-found page is the only shell-bearing route a browser can reach

**Raised by:** 003.02 · **Condition to revisit:** 004.02 lands, making a signed-in page reachable in a browser

The header, the skip link and `main` render on every protected page and on the not-found page. No protected page is reachable without a session, and there is no way to sign in until 004.02 — so every browser-tier assertion about the shell runs against `/no-such-page`, which is the only shell-bearing route left open.

That covers the skip link's real focus behaviour, which is the one thing jsdom cannot test at all. It does not cover the account menu, which renders only for a signed-in user and therefore has no browser-tier coverage whatsoever — its keyboard behaviour is asserted in jsdom against React Aria's own well-tested pattern, and nothing has yet confirmed it in a real browser.

### A deep link to a protected route loses its destination

**Raised by:** 003.02 · **Condition to revisit:** 004.02 reads the `from` state it is handed

`RequireSession` redirects a signed-out visitor to `/` and records where they were going in the navigation state. Nothing consumes it, so the visitor arrives at the landing page and stays there — a shared link to a company view is, today, a link to the landing page.

This is deliberate rather than unfinished: consuming it means validating it, and an unvalidated return address is an open redirect. The prompt that adds sign-in is the one that can test both halves together.

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
| `ThemeControl` already exists and is written for reuse — the header adopts it rather than building a second theme control                    | 003.01    | `003.02` |
| `main` lives inside `LandingPage`; when the shell owns layout there must still be exactly one `main` on the page                             | 003.01    | `003.02` |
| The account menu needs its own token-valued rules in `base.css` — React Aria renders it invisible otherwise                                  | 003.01    | `003.02` |
| The landing page's `h1` is a route-change focus target; making it focusable must not change its name or level                                | 003.01    | `003.02` |
| `startSignIn()` in `src/auth/sign-in.ts` is the seam — replace the body, don't move the call site                                            | 003.01    | `004.02` |
| Extend the four-combination contrast scan to every page; the component tier cannot check contrast at all                                     | 003.01    | `009.02` |
| Assert what is drawn, not only the `data-*` attribute — jsdom resolves neither pseudo-elements nor shorthands                                | 003.01    | `009.02` |
| A polite live region already exists in `App.tsx` — the announcer replaces it rather than adding a second                                     | 003.02    | `003.03` |
| Test the announcer under `StrictMode`; a boolean "have I run?" ref is spent by its double invocation                                         | 003.02    | `003.03` |
| `RequireSession` saves the attempted path as `{ from }`; validate it before navigating, or it is an open redirect                            | 003.02    | `004.02` |
| The OIDC callback route is absent, and must be public — behind the guard it is a redirect loop                                               | 003.02    | `004.02` |
| `startSignOut()` is the seam; sign-out must clear the session, not just the tokens, or the account menu stays                                | 003.02    | `004.03` |
| `SessionProvider`'s `session` prop must keep working for tests when 004.03 derives the real session                                          | 003.02    | `004.03` |
| `Breadcrumbs` exists and takes `readonly Crumb[]`; `CompaniesPage`/`CompanyPage` are placeholders to replace                                 | 003.02    | `006.01` |
| Decide on React Aria's `RouterProvider` if its links start appearing beyond the breadcrumb                                                   | 003.02    | `006.01` |
| `onAccountAction` in `Header.tsx` is the dialogs' entry point; `MenuTrigger` already restores focus on close                                 | 003.02    | `008.06` |
| Scan `document.body`, not the render container — React Aria's popover portals out of it                                                      | 003.02    | `008.06` |
| A jsdom test can be green while the browser is wrong; the shell's browser coverage runs on an unknown address                                | 003.02    | `009.02` |
