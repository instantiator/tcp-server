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

007.01 does not leave the list to speak for itself: `ConsultationsList` passes
`note={t('activity.consultations.partial')}` to `ActivityList`, which renders
the caveat as a visible `<p>` above the rows and, deliberately, outside the
`aria-busy` region — a standing fact about the list, not loading content, so it
survives all four of the list's states rather than vanishing whenever the list
is fetching, failed or empty.

`useLiveConsultationState` (added in 007.02) inherits the same limit: a
consultation that has been requested but not yet picked up has no assignment
row, so there is no id to pass it.

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

### A query string can create a session in a development build

**Raised by:** 003.02 · **Condition to revisit:** a `Session` starts carrying a
token or a permission — **004.03 has now passed without this happening** — or
009.04 generalises the build flag

`?devSession=<id>` supplies a stand-in signed-in user so the shell could be
tested before sign-in existed. It is guarded by `import.meta.env.DEV`, which
Vite replaces with a literal at build time, so the capability is **absent from a
production bundle** rather than disabled in one; `test/browser/app-shell.spec.ts`
asserts that twice, behaviourally and by searching the served JavaScript.

What makes it acceptable today is how little a session is: a user id that
decides whether `RequireSession` renders or redirects. It carries no token, so
tcp-server refuses every request it leads to with a 401 exactly as it would for
a signed-out visitor. It is a way to see the header, not a way to reach data.

That reasoning expires when the session becomes the thing that holds
credentials. The guard protects the artefact, not a developer's own browser, and
nothing stops a future change to `Session` from making `?devSession=admin` mean
something. Written into 004.03 and 009.04; recorded in the memory
`project-dev-session-escape-hatch`.

004.03 was named above as the prompt most likely to trigger this, and it did
not: reload recovery, expiry handling and sign-out all landed with `Session`
still `{ userId }`. That is the good outcome, and it is also the reason this
entry stays open rather than closing. The change that would have broken the
guarantee has now been made without breaking it, so the next person to touch the
type will not be approaching it as the dangerous one — and from here the build
flag is the whole of the defence rather than the second half of it. 009.04 owns
what remains.

### `@react-aria/live-announcer` is a one-line shim over a `private` subpath

**Raised by:** 003.03 · **Condition to revisit:** the shim stops publishing alongside `react-aria`, or `announce` becomes a public export of `react-aria` or `react-aria-components`

[ADR-026](../../ADRs/ADR-026-web-ui-accessibility-and-component-library.md) chose React Aria partly for its live announcer, which is real but not reachable the obvious way: `announce` is absent from `react-aria-components`' index, and that package's exports map contains `"./private/*": null`, deliberately blocking the subpath the function lives at. The application therefore depends on the sibling package `@react-aria/live-announcer`, whose entire published source is `export { announce, clearAnnouncer, destroyAnnouncer } from 'react-aria/private/live-announcer/LiveAnnouncer'`.

This is the least-bad of three options — the alternatives were importing the `private` path directly as a phantom dependency, or hand-rolling two live regions and giving up Adobe's assistive-technology testing. It is fine while Adobe keeps publishing the shim in step with `react-aria`. It stops being fine silently: nothing breaks at install time if the shim is abandoned at an older major, it just quietly stops receiving fixes.

Testable as `npm view @react-aria/live-announcer version` lagging `react-aria`'s major, or as `announce` appearing in `react-aria-components`' index types. Recorded in the memory `project-react-aria-live-announcer-shim`.

### `t` has no plural rules, so announcements are phrased around the gap

**Raised by:** 003.03 · **Condition to revisit:** the phase 03 i18n library lands and replaces `src/strings.ts`

`t(key, params)` fills `{placeholder}` slots and does nothing else. Every announcement wording is therefore written to read acceptably at any count — `'Tasks: {count} added'`, never `'{count} tasks added'`, which is wrong at one.

That constraint is invisible in the code: a later prompt adding `'{count} enquiries waiting'` gets no warning and produces "1 enquiries waiting" for the most common case. It holds only as long as someone remembers why the existing keys are phrased the way they are, which is why it is written into 007.01 as well. Recorded in the memory `project-strings-no-pluralisation`.

### A channel's throttle interval is fixed by whichever announcement opens its window

**Raised by:** 003.03 · **Condition to revisit:** a channel ever gets two writers

`announce({ throttleMs })` is read only when a channel has no open window. A second announcement arriving mid-window joins it and its own `throttleMs` is ignored, so a caller asking for an immediate announcement on a channel that is already accumulating waits for the accumulation instead.

This is correct while a channel belongs to one surface, which is the documented rule and is true of everything built so far. It becomes a real defect the moment two components announce on the same channel with different urgencies — and it fails quietly, as a delay rather than an error. The fix if it happens is a channel per urgency, not a shorter window.

### Nothing consumes `Notification` or `useLoadingAnnouncement`

**Raised by:** 003.03 · **Condition to revisit:** 006.01 and 007.01 build the first views that need them

Both were built without a caller, which is normally the wrong thing to do. They exist because the rules they encode are the ones that get lost when each view reinvents them: that a notification is never the only record of an event (enforced here by `durableHref` being a required prop rather than by review), and that a wait announces its completion and never its start.

The shapes are therefore guesses about what 006.01 and 007.01 will want. If either is wrong, changing it there is the right response — working around it, or building a second component beside it, is not.

**`useLoadingAnnouncement` now has consumers** — `CompanyPage.tsx` (006.01) and,
via `useListChangeAnnouncement`, 007.01's four activity lists. **`Notification`
still has none.** 007.01 considered wiring it to a new enquiry and decided
against it: `Notification` requires a `durableHref`/`durableLabel` pair, and an
enquiry has no URL until 008.04 decides whether its dialog is a route or
component state. A new enquiry is still announced individually and still
appears in the enquiries list in the meantime, so nothing perceptible was lost
by waiting. 008.04 is now the owner of this gap.

### The renewal and the sign-in are the same redirect

**Raised by:** 004.01 · **Condition to revisit:** the `sessionStorage` fallback in [ADR-024](../../ADRs/ADR-024-browser-oidc-client-and-token-handling.md) is taken, so a refresh token exists. Testable: `offline_access` appears in `createUserManagerSettings().scope`.

ADR-024 asks for one renewal attempt, then a redirect to sign-in if that fails. Both halves need something to renew _with_, and this client has nothing: no refresh token, because that is the basis of the in-memory decision, and no hidden iframe, because the ADR rejected the mechanism. So `handleUnauthorized()` makes a single `signinRedirect()` and lets the provider decide. Against a live provider session it returns a fresh token with no form shown, which is the renewal; against an expired one it shows the login page, which is the sign-in.

This is correct only while no refresh token exists. Taking the `sessionStorage` fallback would make a genuine two-step policy possible, and the single call would then be hiding a step rather than collapsing one. Recorded as amendment (a) on ADR-024.

### The bootstrap's Zitadel calls are pinned to port 8080

**Raised by:** 004.01 · **Condition to revisit:** anyone runs `start-deployment.sh` with `EXPOSE_PORT_ZITADEL` set to anything but 8080. Testable: set it and run the script — it fails with a connection error that never names the port.

The `zit()` helper in `scripts/start-deployment.sh` posts to a hardcoded `http://localhost:8080`, while the readiness probe a few lines above it correctly uses `${EXPOSE_PORT_ZITADEL:-8080}`. Pre-existing, and not introduced by the second application registration that sits below it — left alone deliberately rather than fixed in passing, because both committed env files use 8080 and a change here would have gone untested by everything in the repository.

### The local browser client is registered with Zitadel `devMode` on

**Raised by:** 004.01 · **Condition to revisit:** the first deployment on a hostname that is not `localhost`

`devMode: true` relaxes Zitadel's redirect-URI validation, which is what lets a self-signed `https://localhost:<port>` registration work at all. It is correct for a bootstrap that only ever targets the bundled localhost instance, and wrong for anything else — a real deployment registers its client by hand, and `docs/authentication.md` now says what to register. The risk is not that the setting is wrong today; it is that `start-deployment.sh` is the obvious thing to copy when a real deployment is first stood up.

Recorded in the memory `project-zitadel-web-client-devmode`.

### The PKCE verifier and `state` are in `sessionStorage`, so "nothing in browser storage" is not literally true

**Raised by:** 004.01 · **Condition to revisit:** anything else starts writing to `sessionStorage` under an OIDC key, at which point matching on token strings alone stops being sufficient

Tokens are held in an in-memory store, but the PKCE verifier and the `state` nonce cannot be: they have to survive the navigation to the provider and back. Neither is a credential — single-use, scoped to one sign-in, and worthless to an attacker who cannot also receive the callback — so this is a correct configuration rather than a compromise. It is recorded because the shorthand people will remember is "no OIDC material in browser storage", and the test asserts the narrower, accurate property: that no _token_ is.

### The allow-list of return destinations is maintained by hand

**Raised by:** 004.02 · **Condition to revisit:** a third route goes behind `RequireSession`, or the route table in `App.tsx` stops fitting on one screen. Testable: count the guarded routes in `App.tsx` against the entries in `RETURNABLE_ROUTES`.

`safeRedirectTarget()` refuses any destination that is not one of the routes named in `RETURNABLE_ROUTES` (`src/auth/redirect-target.ts`). That list cannot simply be the route table: the catch-all `*` matches every address, and `/` and `/callback` are both the redirect loop, so an allow-list derived from the table would allow exactly what it exists to refuse.

Deriving both from one shared array is the fix, and it was not worth the indirection for two entries. The failure it leaves is mild and silent — a route added later and not listed still works, but a user sent there before signing in arrives at `/companies` instead, with nothing to say why. Written into `006.01`, which is the next prompt to touch those routes, and recorded in the memory `project-oidc-callback-and-return-routes`.

### A signed-in browser journey is proven only in jsdom

**Raised by:** 004.02 · **Condition to revisit:** `009.01` lands journey 1. Testable: `test/browser/` contains a spec that reaches a page behind `RequireSession`.

`CallbackPage.test.tsx` intercepts `signinCallback()` on the real `UserManager`, so everything above the exchange is real — the provider mount, the session derivation, the route table, the redirect-target validation. The exchange itself is not: the redirect to Zitadel, the PKCE round trip, and the provider's own response have no coverage in any tier. `test/browser/oidc-registration.spec.ts` sends a real authorize request but has nowhere to land, and `app-shell.spec.ts` still runs the shell's coverage on `/no-such-page` for the same reason.

That is a gap in what is proven, not a compromise taken — 009.01 is the prompt that closes it, and both notes are written into it.

### Signing out in one browser tab leaves the others looking signed in

**Raised by:** 004.03 · **Condition to revisit:** `monitorSession` becomes usable without third-party cookies, or someone reports a stale tab. Testable: `check_session_iframe` appears in the provider's discovery document _and_ the browser still delivers the provider's cookie to an iframe on this origin.

Tokens are per-tab, because the store is per-tab: an in-memory user store is not shared, and neither is anything derived from it. So signing out in one tab ends that tab's session and the provider's, but a second tab keeps its own copy of a user the provider no longer recognises. Its header still offers an account menu, and it stays that way until its next request comes back 401 and `handleUnauthorized()` sends it to the provider, which by then has no session to return.

The two mechanisms that would close this are both rejected or unavailable. `monitorSession` is the library's own answer and works by polling a hidden iframe against the provider's `check_session_iframe` — the third-party-cookie mechanism [ADR-024](../../ADRs/ADR-024-browser-oidc-client-and-token-handling.md) rejected for renewal, for the same reason it would fail here. `BroadcastChannel` would work and is a dozen lines, but it broadcasts a sign-out that a tab is free to ignore, and it buys a shorter window rather than a closed one — every tab still ends up correct at its next request either way.

So this is a compromise taken knowingly: the window is bounded by the next request, the failure is a menu that looks live rather than access that is, and no data is reachable through it. It becomes worth revisiting if a user meets it, or if the browser and the provider make the iframe approach honest again.

### Reload recovery has no cross-page-load loop counter

**Raised by:** 004.03 · **Condition to revisit:** a provider is observed returning a user with no `sub`, or one already expired on arrival. Testable: `AuthSession` yields `null` for a user that `react-oidc-context` reports as authenticated.

`RequireSession` redirects to the provider when it has no session, which is the same shape of hazard `/callback` was written to avoid — a page that re-attempts sign-in on mount can bounce forever. Three things stop it here, and none of them is a counter: `handleUnauthorized()`'s module latch absorbs StrictMode's double mount and any second guarded component; the `failed` flag stops the effect re-firing after a rejection, which is the only way that latch reopens; and the provider's return leg always lands on `/callback`, which never redirects on its own.

The gap those three leave is narrow but real. A page load is where the latch resets, so the loop that survives is one that completes a round trip and still arrives with no session — which needs a provider that returns a user the exchange accepts but `AuthSession` maps to nothing. `sub` is mandatory in an ID token and `isAuthenticated` already excludes an expired user, so this is close to unreachable against a conforming provider, and a `sessionStorage` counter to guard it would have to be cleared on a successful sign-in or it would break the legitimate second recovery an hour later.

Left out deliberately, with the reasoning recorded in `session.tsx` beside the code rather than only here. An unreachable provider does **not** produce this: `signinRedirect()` rejects before navigating, and the guard shows an error with a manual retry.

### `openapi-fetch` is a `0.x` dependency under the application's whole data layer

**Raised by:** 005.01 · **Condition to revisit:** the package reaches 1.0, or a minor release breaks the build

Reasoning: chosen over hand-written conditional types because those are where the "no `any` at the boundary" rule breaks in practice — openapi-fetch is by openapi-typescript's author, in the same repository, MIT, one transitive dependency, and its middleware hook is where the shared 401 policy goes. Pre-1.0 means a minor version may break. The exposure is bounded: one import in `src/api/client.ts` plus the type plumbing in `src/api/queries.ts`, and the fallback — hand-written generics over the same generated `paths` type — stays available.

### `MAX_STREAMS = 12` is a guess

**Raised by:** 005.02 · **Condition to revisit:** the first time a real view is refused, or when 007.01 establishes an actual per-view stream count

Picked as twice HTTP/1.1's six-per-origin ceiling, with headroom for a live view plus several dialogs — not measured against anything built. No view yet opens more than one stream, so the number has never been tested against real usage.

**007.01 was the first real view, and it opened zero additional streams.** The
live activity view reuses `CompanyPage`'s single existing company subscription
and reads the four lists off the TanStack Query cache that subscription
patches — `CompanyActivity` opens no `useEventStream` of its own. So the
condition to revisit is still untriggered, and the constant was not raised.
Recorded explicitly so this reads as "checked, still true" rather than "not
checked."

### The browser tier authenticates as a machine client, not a user

**Raised by:** 005.02 · **Condition to revisit:** when 009.01 builds a real end-user sign-in helper

`test/browser/event-streams.spec.ts` proves the transport carries seven concurrent streams, using a `client_credentials` grant. It does not prove a signed-in human can open seven — that needs a real OIDC login, which no browser-tier test performs yet.

### Reconnection correctness is load-bearing on server-side priming

**Raised by:** 005.02 · **Condition to revisit:** any change to `CompanyPrimingService.prime`, `TaskController.primeTaskEvents` or `AgentController.replayTerminal` — this needs ADR-025 revisited, not just a test fixed

The client keeps no bookkeeping across a drop: no last-seen id, no replay buffer. A reconnected stream re-renders correctly only because the company and task streams keep priming with current state on every subscribe, and the agent stream keeps synthesising a terminal event for a late subscriber. That coupling is recorded in ADR-025, not enforced by any type the client and server share.

### The generated client was typed against entities the Swagger plugin never read

**Raised by:** 006.01 · **Condition to revisit:** a new entity model is added
outside `libs/tcp-shared/src/models/*.model.ts`, or `dtoFileNameSuffix` in
`apps/backend/nest-cli.json` is edited. Testable: `grep -c 'Record<string,
never>;' apps/frontend/tcp-frontend/src/api/schema.d.ts` returns more than 2.

The `@nestjs/swagger` CLI plugin only synthesises `@ApiProperty` metadata for
files matching `dtoFileNameSuffix` (default `['.dto.ts', '.entity.ts']`). The
entities live in `libs/tcp-shared/src/models/*.model.ts`, which matched
neither default, so eight of them reached the web client as `Record<string,
never>` — a type with no properties at all — across 29 operations. The
failure is silent at its cause and surfaces only as a compile error at a call
site, in another package, whenever someone finally tries to read a field.
Fixed by adding `.model.ts` to the suffix list.

### The generated schema documents the persistence shape, not the wire shape

**Raised by:** 006.01 · **Condition to revisit:** any API read path starts
passing `relations:`, or a model gains `eager: true`. Testable: `grep -rn
'relations:' apps/backend/apps/tcp-server/src/` returns a hit on a route the
web UI calls.

TypeORM relation properties are declared `!` because they are required _in
the database_, but no relation is eager-loaded and `relations:` appears in
only two non-route places (`chat.service.ts`, `system-drain.service.ts`). So
a response carries the foreign-key columns and not the related objects, and
the `OmitType` DTOs in `entity-response.dto.ts` encode exactly that, dropping
each unloaded relation while copying the rest of the model's metadata.
Nothing fails if it stops being true — the schema just quietly
under-describes the response.

### `GET /api/company/{id}` answers 200 with `null` for a company the caller cannot see

**Raised by:** 006.01 · **Condition to revisit:** the handler starts
returning 404, or the response is documented as nullable. Testable:
`CompanyPage.tsx` no longer needs its `data ?? undefined`.

It is a successful response carrying no company, so it reaches the browser
as data rather than as an error, and the generated type says a company is
always present. The `@ApiOkResponse({ type: CompanyResponseDto })` added in
006.01 does not describe the null case. 404 would be the honest answer, but
changing it is a behavioural change to a route other callers use, not
something to fix in passing.

### Most e2e specs still clean up by emptying shared tables

**Raised by:** 006.01 · **Condition to revisit:** a spec fails on data it did
not create, or the tier's failure rate rises above zero again. Testable:
`grep -rc 'createQueryBuilder().delete().execute()' apps/backend/test/e2e/`
returns hits in more than a couple of files.

Every spec in the e2e tier shares one Postgres database, migrated once by
`global-setup.ts` and never reset between spec files, so each spec is
responsible for its own rows. About fourteen of them discharge that
responsibility with `repo.createQueryBuilder().delete().execute()` — no `WHERE`
clause — which removes every row in the table rather than the ones that spec
created. `system-shutdown.e2e-spec.ts` was rescoped to its own `companyId` in
006.01, because its four unqualified deletes over the audit table made it the
slowest hook in the tier; the rest were left alone.

Under `maxWorkers: 1` this is usually harmless, because files run one at a
time. What it leaves is no margin: the moment any spec has an async write still
in flight past its own teardown — a BullMQ job, a fire-and-forget audit post —
the next spec's first blanket delete removes it, and the symptom lands in a file
that did nothing wrong. Two specs also collide on genuinely global unique
constraints: `tcp_company.slug` is hardcoded `'acme'` in both
`agent.e2e-spec.ts` and `company-role.e2e-spec.ts`, and `Conversation.slug` is
derived from a role name, so the role `analyst`/`Analyst` in
`internal-conversation.e2e-spec.ts` and `task-company-events.e2e-spec.ts` both
produce `analyst-1`.

None of this was observed firing — the tier's actual flake had a different and
now-fixed cause (see the memory `project-e2e-jwt-flake`: supertest was binding a
fresh ephemeral port per request, colliding with Docker's dynamic container port
mappings, so requests were occasionally answered by a container). Scoping the
remaining deletes and namespacing the two slugs is a tidy-up worth doing on its
own merits, not a fix for a known failure, which is why it was not bundled into
006.01.

### The activity view fetches four lists the stream had already primed

**Raised by:** 007.01 · **Condition to revisit:** the mount cost of the four
requests becomes measurable, or a second view needs the same four lists.
Testable: the browser network panel shows a list refetched within a second of
its first response.

The originating prompt said the view should "render from the stream's
priming, without a separate fetch." It does not: `AgentsList`, `TasksList`,
`ConsultationsList` and `EnquiriesList` fetch through `useAgents`, `useTasks`,
`useAssignments` and `useConversations`, and the company stream's events then
patch what those hooks cached. This is ADR-025's architecture, not a
deviation from it — `useEventStream` never exposes audit events to a caller,
it folds every one into the TanStack Query cache via `applyEvent`, and
priming's documented role there is reconnect recovery, not initial render.

Rendering from priming directly would have needed `useEventStream` widened to
expose events, a second source of truth beside the cache that 008.x's dialogs
also read, and — decisively — the event collection lifted out of the activity
view and into `CompanyPage`, because `CompanyActivity` mounts inside the
`company !== undefined` branch, _after_ the subscription already opened, and
would therefore miss its own priming. The alternative was rejected for that
timing reason, not because it was more effort.

### `TaskChangeSummary` carries fields `TcpTask` does not

**Raised by:** 007.01 · **Condition to revisit:** a view wants to show
`completedSteps`/`totalSteps`. Testable: `grep -rn 'completedSteps'
apps/frontend/tcp-frontend/src` matches outside `api/schema.d.ts`.

A stream patch merges whatever fields its summary carries onto the cached
row, and `TaskChangeSummary` carries `completedSteps`/`totalSteps` that
`TcpTask` — the REST shape `useTasks` fetches — never had. So such a field is
absent on first paint and materialises only after the first matching event,
which is worse than a field that was never shown at all: the row's shape
changes under a reader for no reason they can see. `TasksList`
(`src/pages/CompanyPage/activity/lists.tsx`) deliberately renders neither
field, with a comment at the point they would go.

### Live agent rows are patched from a reconstructed summary

**Raised by:** 007.01 · **Condition to revisit:** the agent `state_change`
writers start attaching an `AgentChangeSummary`. Testable: `grep -rn "entity:
'agent'" apps/backend --include=*.ts` shows a `summary` alongside.

`synthesiseAgentPatch` in `src/events/cache.ts` exists because 002.04 widened
the company channel's routing predicate to include `agent` rows but did not
change the roughly eight places that write one — several of them in
`tcp-agent`, across a process boundary. So a **primed** agent row carries an
`AgentChangeSummary` and a **live** one carries nothing but `event.agentId`
and `payload.newStatus`. Without the reconstruction, agent status — the
highest-frequency event on the company stream — would be the one change that
refetches an entire list instead of patching the row it names.

It becomes dead code silently the day those writers start sending a real
summary, because `applyEvent` prefers `hasStringId(summary)` and only falls
back to `synthesiseAgentPatch` when that is absent — nothing needs to notice
or remove the fallback for the fix to take effect.

### `useCompanies` is not live

**Raised by:** 007.02 · **Condition to revisit:** a view exists that shows more than one company and must reflect a change to any of them without a reload

Every other list hook in `src/api/hooks.ts` patches itself from the company
SSE channel. `useCompanies` cannot: only per-company channels exist, so there
is no stream to patch it from. A list-level stream would have to be built.

It would otherwise patch whichever company the current page happens to be
subscribed to and no other, which is worse than not patching at all, because
it looks like it works. `CompaniesPage` refetches on mount instead, and that
is enough for it.

## Carried into a later prompt

| Note                                                                                                                                                                                                 | Raised by | Goes to  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------- |
| End-to-end test that more than six simultaneous event streams work — 002.03 proved the transport, not the streams                                                                                    | 002.03    | `005.02` |
| `tcp-web` is handed the confidential OIDC client as a stopgap; it needs the public PKCE one, and `https` redirect URIs from `TCP_WEB_URL`                                                            | 002.03    | `004.01` |
| A catch-all route: nginx returns the app document for any deep link, so an unknown path currently renders blank rather than a 404                                                                    | 002.03    | `003.02` |
| The browser tier drives the deployment over https with no local-server fallback, and runs inside CI's `api-test` job                                                                                 | 002.03    | `009.01` |
| Regenerate the client after 002.04: `GET /api/company` (`?all`, `stats`), `GET /api/assignment` (`?mode`), and four summary types changed                                                            | 002.04    | `005.01` |
| The stat field names: `stats.activeAgents`, `stats.tasksByStatus` (zero-filled per status) and `stats.openEnquiries`, returned with the list                                                         | 002.04    | `006.01` |
| The company stream's five `payload.entity` values, the priming order, the summary shapes, and the exact consultations query                                                                          | 002.04    | `007.01` |
| Live `agent` rows carry no summary — only primed ones do; render from priming and patch by `agentId`                                                                                                 | 002.04    | `007.01` |
| Enquiries stream open and close only — no per-message event, so a reply in progress is invisible until it closes                                                                                     | 002.04    | `007.01` |
| Memberships come from the scoped `GET /api/company`; 002.04 added to this prompt's **Needs first**                                                                                                   | 002.04    | `008.06` |
| SSE streams now refuse a non-member with `403` at connect — a permanent failure the backoff must not retry forever                                                                                   | 002.05    | `005.02` |
| `?all=true` is administrator-only; a `403` in the overview is a real error, not an empty state                                                                                                       | 002.05    | `006.01` |
| The memberships dialog is authoritative — membership _is_ the access control, so the list is exactly what the user can reach                                                                         | 002.05    | `008.06` |
| The ADR-011 **permission flags** (migration, defaults, `@RequirePermission`, and the UI to set them) — 002.05 enforced membership only                                                               | 002.05    | `010.01` |
| ADR-011's status wording: membership is enforced, flags are not; `route-audit.spec.ts` must stay green and cover every controller                                                                    | 002.05    | `009.03` |
| `ThemeControl` already exists and is written for reuse — the header adopts it rather than building a second theme control                                                                            | 003.01    | `003.02` |
| `main` lives inside `LandingPage`; when the shell owns layout there must still be exactly one `main` on the page                                                                                     | 003.01    | `003.02` |
| The account menu needs its own token-valued rules in `base.css` — React Aria renders it invisible otherwise                                                                                          | 003.01    | `003.02` |
| The landing page's `h1` is a route-change focus target; making it focusable must not change its name or level                                                                                        | 003.01    | `003.02` |
| `startSignIn()` in `src/auth/sign-in.ts` is the seam — replace the body, don't move the call site                                                                                                    | 003.01    | `004.02` |
| Extend the four-combination contrast scan to every page; the component tier cannot check contrast at all                                                                                             | 003.01    | `009.02` |
| Assert what is drawn, not only the `data-*` attribute — jsdom resolves neither pseudo-elements nor shorthands                                                                                        | 003.01    | `009.02` |
| `RequireSession` saves the attempted path as `{ from }`; validate it before navigating, or it is an open redirect                                                                                    | 003.02    | `004.02` |
| The OIDC callback route is absent, and must be public — behind the guard it is a redirect loop                                                                                                       | 003.02    | `004.02` |
| `startSignOut()` is the seam; sign-out must clear the session, not just the tokens, or the account menu stays                                                                                        | 003.02    | `004.03` |
| `SessionProvider`'s `session` prop must keep working for tests when 004.03 derives the real session                                                                                                  | 003.02    | `004.03` |
| `Breadcrumbs` exists and takes `readonly Crumb[]`; `CompaniesPage`/`CompanyPage` are placeholders to replace                                                                                         | 003.02    | `006.01` |
| Decide on React Aria's `RouterProvider` if its links start appearing beyond the breadcrumb                                                                                                           | 003.02    | `006.01` |
| `onAccountAction` in `Header.tsx` is the dialogs' entry point; `MenuTrigger` already restores focus on close                                                                                         | 003.02    | `008.06` |
| Scan `document.body`, not the render container — React Aria's popover portals out of it                                                                                                              | 003.02    | `008.06` |
| A jsdom test can be green while the browser is wrong; the shell's browser coverage runs on an unknown address                                                                                        | 003.02    | `009.02` |
| `?devSession=` builds a `Session` from a URL — when a session carries a token, it must not be able to mint one                                                                                       | 003.02    | `004.03` |
| The production build flag, removing dev-only capabilities from the artefact, and query-string feature flags                                                                                          | 003.02    | `009.04` |
| The four state components exist with fixed props; `LoadingState` does not set `aria-busy` — the loading region's owner must                                                                          | 003.03    | `006.01` |
| `useLoadingAnnouncement(loading, completion)` announces a completed wait only; never announce that loading started                                                                                   | 003.03    | `006.01` |
| The final announcement wording for all four lists, and the three lists' missing keys — `announce.tasks*` are placeholders                                                                            | 003.03    | `007.01` |
| One announcer channel per list, and never a live region; the announcer counts repeats, so guard on the value that changed                                                                            | 003.03    | `007.01` |
| Where a `Notification` renders is 007.01's layout decision — 003.03 ships the component with no queue, provider or container                                                                         | 003.03    | `007.01` |
| Suppressing per-token announcements is the caller's job — the throttle thins what was announced, it does not decide what to announce                                                                 | 003.03    | `008.01` |
| An individually-announced enquiry needs its own channel, not a `throttleMs` override on a shared one                                                                                                 | 003.03    | `008.04` |
| Tune `ANNOUNCE_THROTTLE_MS` (10s) and `ANNOUNCE_LOADING_MIN_MS` (1s), and record the values the manual pass lands on                                                                                 | 003.03    | `009.02` |
| Confirm `ErrorState`'s `role="group"` plus assertive announcement reads as well as `role="alert"`, and listen for assertive truncation                                                               | 003.03    | `009.02` |
| Only route change has browser-tier announcement coverage; coalescing, throttling and assertive politeness are jsdom-only                                                                             | 003.03    | `009.02` |
| `AuthProvider` must wrap `getUserManager()`'s existing instance, not fresh settings — two managers hold two different users                                                                          | 004.01    | `004.02` |
| `renderAppAt` must mirror whatever `main.tsx` gains, or the component tier asserts a stack that only exists in tests                                                                                 | 004.01    | `004.02` |
| ~~The callback route completes the flow with `signinRedirectCallback()`~~ — **wrong**: `AuthProvider` does it, and doing both double-exchanges the code (corrected by 004.02)                        | 004.01    | `004.02` |
| `handleUnauthorized()` also sets `state.from`, and its value carries a query string where `RequireSession`'s does not                                                                                | 004.01    | `004.02` |
| Sign-out is `signoutRedirect()` plus clearing the in-memory user; the registered post-logout URI is `${TCP_WEB_URL}/`                                                                                | 004.01    | `004.03` |
| `signoutRedirect()` throws with no `end_session_endpoint` — optional in OIDC, so fall back to clearing locally rather than throwing                                                                  | 004.01    | `004.03` |
| The storage assertion must be re-run when the session starts carrying a token, not assumed to still cover it                                                                                         | 004.01    | `004.03` |
| The fetch wrapper calls `getAccessToken()` per request and `handleUnauthorized()` on 401; the policy redirects, it does not renew and return                                                         | 004.01    | `005.01` |
| The stream reader calls `getAccessToken()` on every connection attempt including reconnects, and routes a connect 401 to the shared policy                                                           | 004.01    | `005.02` |
| A profile dialog showing a bare subject has a configuration cause: `OIDC_LOAD_USER_INFO`, not a rebuild                                                                                              | 004.01    | `008.06` |
| Assert against the production bundle that no token reaches browser storage — jsdom proves the configuration, not the artefact                                                                        | 004.01    | `009.04` |
| The session derivation landed in 004.02, not here — `AuthSession` exists, the `session` prop is its fallback, and the OIDC user wins                                                                 | 004.02    | `004.03` |
| `AuthProvider` is already mounted; `matchSignoutCallback`/`onSignoutCallback` are the sign-out return hooks — do not add a second route                                                              | 004.02    | `004.03` |
| Adding a guarded route means adding it to `RETURNABLE_ROUTES`; `DEFAULT_SIGNED_IN_PATH` is hardcoded to `/companies` and needs confirming                                                            | 004.02    | `006.01` |
| Journey 1 is sign-in's first browser coverage — the jsdom tier intercepts the exchange and proves nothing about the PKCE round trip                                                                  | 004.02    | `009.01` |
| Retire `app-shell.spec.ts`'s `/no-such-page` workaround: a signed-in page is browser-reachable now                                                                                                   | 004.02    | `009.01` |
| The `/callback` route's loading and error states need the manual pass, and it is a signed-out page the contrast scan can reach                                                                       | 004.02    | `009.02` |
| The "a request after token expiry recovers" test — 004.03 was asked for it and had no fetch wrapper to make the request                                                                              | 004.03    | `005.01` |
| Reconnecting a stream after expiry must send the _new_ token on the wire; the failure is a permanent loop after the first blip, not at expiry itself                                                 | 004.03    | `005.02` |
| A real-browser journey through sign-in, reload and sign-out — 004.03 proves only that a guarded route leaves for the provider                                                                        | 004.03    | `009.01` |
| The expiry warning interrupts assertively and is the only surface that speaks unprompted; it and the two recovery states need the manual pass                                                        | 004.03    | `009.02` |
| ADR-024 now carries (a)–(l); confirm the deliberately-unwired `matchSignoutCallback` and the two operator-facing limitations survived                                                                | 004.03    | `009.03` |
| `Session` stayed `{ userId }` through 004.03, so the build flag is now the whole of what stops `?devSession=` mattering                                                                              | 004.03    | `009.04` |
| Query keys are `[entity, scope, …]` keyed on the event's `payload.entity` — conversations key on `'enquiry'`                                                                                         | 005.01    | `005.02` |
| `ApiError` (`src/api/errors.ts`) is the one failure shape; the stream reader throws it too                                                                                                           | 005.01    | `005.02` |
| One redirect across a fetch 401 and a stream 401 together is untested — each side is proven alone                                                                                                    | 005.01    | `005.02` |
| `App.tsx`'s boundary-control `<span>` still has no real import to replace it                                                                                                                         | 005.01    | `005.02` |
| SSE payload summary types are absent from the OpenAPI description; the drift check cannot police the event contract                                                                                  | 005.01    | `005.02` |
| Mutation hooks are unwritten; the client and error shape they use are built                                                                                                                          | 005.01    | `006.01` |
| The two knowledge file-download GETs have no query hook, by design                                                                                                                                   | 005.01    | `010.01` |
| `useEventStream(streamUrls.company(id))` already subscribes on the company route; build on it, don't open a second connection                                                                        | 005.02    | `006.01` |
| The hook returns an `error` that nothing renders yet — 006.01 owns giving a stream failure a visible state                                                                                           | 005.02    | `006.01` |
| The live activity view is the first place `MAX_STREAMS = 12` could plausibly bite; raise it deliberately if a view needs more                                                                        | 005.02    | `007.01` |
| Token-level `StreamDelta`s reach a transcript via `useEventStream`'s `onDelta` and belong in local state, never the query cache                                                                      | 005.02    | `008.01` |
| A `403` on a stream is a permanent `ApiError`, never retried — render it as a refusal, not a spinner that never resolves                                                                             | 005.02    | `008.01` |
| Each open chat's `StreamDelta`s belong in that conversation's own local state, kept separate across several open chats                                                                               | 005.02    | `008.02` |
| The browser tier can mint a machine token but not a human one; a real end-user sign-in helper is still unbuilt                                                                                       | 005.02    | `009.01` |
| SSE payload summary types are absent from the OpenAPI description; the generated-types drift check can't police the event contract                                                                   | 005.02    | `009.03` |
| `CompanyPage`'s tab frame has one empty `<TabPanel id="activity">` — render the live activity view into it, don't restructure the page                                                               | 006.01    | `007.01` |
| `useEventStream(streamUrls.company(id))` and its `ErrorState` on channel `company-stream` already exist on `CompanyPage` — reuse both, don't add a second of either                                  | 006.01    | `007.01` |
| `useLoadingAnnouncement`'s second argument is `Announcement \| null` — pass `null` on the failure path, not an announcement                                                                          | 006.01    | `007.01` |
| `{count}` is reserved in announcement strings — `announcer.ts`'s `flush` supplies it and overwrites any caller value under that name                                                                 | 006.01    | `007.01` |
| Per-status task counts aren't on the overview; `ACTIVE_TASK_STATUSES` sums four non-terminal statuses into one "Active tasks" figure                                                                 | 006.01    | `007.01` |
| Adding the second tab is one line in `CompanyPage.tsx`'s `TabList`/`TabPanel`; the keyboard test then needs real arrow-key navigation assertions                                                     | 006.01    | `010.01` |
| `GET /api/company/{id}` answers 200 with `null` for a company the caller cannot see; the generated types don't say so — `CompanyPage.tsx` collapses it to `undefined`                                | 006.01    | `010.01` |
| A `<ul>` styled with `list-style: none` loses its list role in Safari/VoiceOver — check the overview's and 007.01's lists once themes fill the empty rule bodies                                     | 006.01    | `009.02` |
| The overview's `403` branch (a non-administrator sending `?all=true`) is proven only in jsdom — needs one browser-tier confirmation                                                                  | 006.01    | `009.02` |
| `base.css`'s new `.react-aria-Tab*` rules carry the selected state by border, not colour (WCAG 1.4.1) — cover the tab list in the contrast scan, both themes and modes                               | 006.01    | `009.02` |
| `?all=true` stays administrator-only and the overview never sends it; document its `403` as a refusal, not an empty state                                                                            | 006.01    | `009.03` |
| Agent and consultation rows are non-interactive in the MVP; 007.01 decided against adding an assignment dialog, so no assignment-scoped transcript surface is needed                                 | 007.01    | `008.01` |
| The task dialog is reached from a tasks-list row in the activity view; it needs no `assignmentId` focus parameter, because agent rows deliberately do not open it                                    | 007.01    | `008.03` |
| The enquiry notification container is 008.04's to build, once it decides whether an enquiry has a URL — `Notification` requires a `durableHref` and nothing renders one yet                          | 007.01    | `008.04` |
| The 'add new' control is unbuilt — 007.01 deferred it whole, since both its actions open dialogs that did not exist yet                                                                              | 007.01    | `008.07` |
| `ActivityList` in `pages/CompanyPage/activity/` is the shared four-state frame for a live list (region, heading, count, loading/error/empty/populated) — reuse it rather than repeating the contract | 007.01    | `008.07` |
| The four activity lists are the first `<ul>`s that a theme will style; check the Safari/VoiceOver `list-style: none` role loss on all of them                                                        | 007.01    | `009.02` |
| The announcement wordings and the ~10s `ANNOUNCE_THROTTLE_MS` are unverified against a real screen reader — the activity view is the surface to tune them on                                         | 007.01    | `009.02` |
| The two chat hooks exist with no consumer, so their shape is unproven                                                                                                                                | 007.02    | `008.02` |
| ADR-030's `Live` prefix needs rechecking against `STATIC_ENTITIES`                                                                                                                                   | 007.02    | `009.03` |
| The four remaining MVP journeys — create a task and watch it progress, chat with a role, answer a user enquiry, sign out and land on the landing page                                                | 007.03    | `009.01` |
