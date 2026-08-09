# ADR-030: Component Hooks for Live Data

**Status:** Accepted (2026-08-09)

## Context

Three ways of looking at a company are planned: the plain list view built in
`007.01`, an arranged layout that uses the space better, and an illustrated
office where agents sit in cubicles and walk to meeting rooms. They show the
same data. They will be written at different times, probably by different
people.

After `007.01` the data was reachable, but only if you already knew the system.
A component asked for its rows through a hook named after a REST route:

```tsx
// What the consultations list actually called.
const query = useAssignments({ companyId, taskId: 'null', mode: 'consultee' });
```

Nothing there says "consultations". `taskId` is the four-character string
`'null'` rather than JS `null`, because the server tests for that exact string.
A chat is the same endpoint with `mode: 'chat'`, which nobody would guess. The
knowledge needed to fetch a thing lived in a comment inside the one component
that had already worked it out.

The second problem is quieter. Some of this data is pushed to the browser over
SSE and updates itself; roles and knowledge never are. Both kinds looked
identical, so the whole surface read as if everything stayed fresh on its own.

## What needs deciding

1. How a component author finds the hook for the thing they are drawing.
2. How they know whether what they get will keep itself up to date.
3. What stops each of thirty avatars in the illustrated view opening its own
   event stream.

## Options considered

|                                       | **Named hooks over the cache** | Hooks named after routes (as built in 007.01) | A context object per view               |
| ------------------------------------- | ------------------------------ | --------------------------------------------- | --------------------------------------- |
| Findable without reading the server   | Yes                            | No                                            | Yes                                     |
| Says whether it is live               | Yes, in the name               | No                                            | Only if documented                      |
| Encodes the awkward query shapes      | Once, in the hook              | Once per component that needs it              | Once, in the provider                   |
| Works for a component nested anywhere | Yes                            | Yes                                           | Only inside its provider                |
| New machinery                         | One module                     | None                                          | A provider, and prop-drilling its shape |

## Decision

**Components read data through one module of hooks named after what is on
screen, and a `Live` prefix means the value updates itself.**

Three parts:

- **[One door](#one-door).** `src/api/hooks.ts` is the only data module a
  component imports. `endpoints.ts` behind it stays one hook per REST route.
- **[`Live` means push-updated](#live-means-push-updated).** Its absence is a
  fact about the system, not an oversight.
- **[No hook opens a stream](#no-hook-opens-a-stream).** The page owns the one
  subscription; hooks only read the cache it patches.

## Consequences

- A component author has one list to read, and every entry names something
  they can see on the page.
- The queries nobody would guess — `mode: 'chat'`, `taskId: 'null'` — are
  written down once, with the reason, instead of being rediscovered.
- **Roughly half of these hooks are one-line aliases.** That is the cost, and
  it is deliberate: a naming scheme you have to know the exceptions to is worse
  than no scheme, because it silently sends you back to reading the server.
- **A hook that becomes live later has to be renamed, and so does every
  caller.** That is the point of the prefix — the rename is the signal. It is
  cheap while the callers are few and gets dearer; `009.03` rechecks the
  boundary before phase 02 closes.
- The boundary is a lint rule, so it fails at the keyboard rather than at
  review. It also means adding a route now takes two edits, not one.
- Detail routes are flattened, not wrapped: [see below](#detail-routes-are-flattened-not-wrapped).

## Alternatives considered

- **Leave the route-named hooks as the surface.** Cheapest, and it is what
  `007.01` had. Rejected because the cost lands on every future view rather
  than once here, and because it leaves no place to say which data is live.
- **A React context per view holding the company's data.** Would work for the
  plain list. Rejected for the illustrated office: a deeply nested avatar
  either sits inside the provider or gets its data drilled down to it, and the
  provider's shape then has to anticipate every view that will ever use it.
- **Let each hook open its own stream, and deduplicate connections.**
  `subscriptions.ts` already dedupes by URL, so this nearly works. Rejected
  because "nearly" is the problem: the cap counts distinct URLs, and a view
  that legitimately watches several agents would trip it in a way that depends
  on what else is on screen.
- **Narrow list rows to hand-written summary types.** Rejected: the list routes
  already return lighter rows than the detail routes, and a live event spreads
  wire-summary fields onto a cached row — so a narrowed type would promise a
  shape the cache does not keep.

## Prompts to update when this is decided

- `008.02`, `008.03`, `008.04` — the dialogs, which read single entities
- `009.03` — documentation close-out, which rechecks the prefix

## Detail

### One door

```
src/api/
  hooks.ts        The only module a component imports.
  endpoints.ts    One hook per REST route. Internal.
  query-keys.ts   Cache keys. Internal.
  client.ts       The generated client and its auth middleware. Internal.
```

`hooks.ts` re-exports the endpoint hooks that have no facade — histories,
knowledge, company users — so nothing has a reason to reach past it.

The rule is `no-restricted-imports` in
`apps/frontend/tcp-frontend/eslint.config.mjs`, the same mechanism that keeps
the server-only half of `@tcp/shared` out of the browser. It is declared twice:
once for every file, once for `src/api/**` with the endpoints restriction
dropped. **A second declaration of a rule replaces the first rather than
merging with it**, so both share one const. Editing one copy and not the other
would silently delete the `@tcp/shared` boundary, and the only thing that would
notice is `npm run test:import-boundary`.

### `Live` means push-updated

An event arrives over SSE, `applyEvent` patches the shared query cache, and
every hook reading that cache re-renders. `query-keys.ts` names the five
entities this can happen to in `EVENT_ENTITIES`, and the three it cannot in
`STATIC_ENTITIES`:

| Prefixed `Live`                           | Not prefixed                  |
| ----------------------------------------- | ----------------------------- |
| company, agent, task, assignment, enquiry | role, company-user, knowledge |

So `useCompanyRolesList`, `useCompanyKnowledgeList` and `useRoleState` carry no
prefix. A component wanting both a company's live state and its roles calls
`useLiveCompanyState(id)` alongside the plain `useCompanyRolesList(id)`.

`useCompanies` has no prefix for a different reason. Its entity _is_ live, but
only per-company channels exist — there is no company-list stream. It would
patch a company the current page happens to be subscribed to and no other,
which is worse than not patching at all, because it looks like it works.

A chat and a consultation are both assignments, so both are live; what makes
them different is the `mode` the hook fills in.

### No hook opens a stream

`CompanyPage` calls `useEventStream` once. Everything below it reads the cache
that subscription patches. `MAX_STREAMS` in `subscriptions.ts` is 12 — twice
the six-per-origin ceiling HTTP/1.1 imposes — and an illustrated office calling
`useLiveAgentState` once per avatar would pass that on a busy company.

This is the rule most likely to be broken by accident, because opening a stream
inside a hook would work fine in the view that first does it. `openStreamCount()`
is exported from `subscriptions.ts` for checking.

### Detail routes are flattened, not wrapped

`useLiveTaskState` and `useLiveEnquiryState` read two routes that used to
return a wrapper object and declare no `@ApiOkResponse`:

| Route                          | Handler used to return                        |
| ------------------------------ | --------------------------------------------- |
| `GET /api/task/{id}`           | `{ task, assignments }`                       |
| `GET /api/conversation/{slug}` | `{ conversation, messages, companyTimezone }` |

With no declared response body, the generated type carried none, so every
property access failed to compile — and even fixed, a wrapper would have been
the wrong shape. The cache patches a cached row by matching its top-level
`id`, and a wrapper has none. `007.02` closed both: the handlers now return
`TaskDetailResponseDto` and `ConversationDetailResponseDto`
(`entity-response.dto.ts`), the entity's own fields at the top level with the
extras — `assignments`, or `messages` and `companyTimezone` — beside them.

The same scan found a second version of the bug in five knowledge routes
(`GET /api/role/{roleId}/knowledge`, `/knowledge/status`, `/knowledge/query`,
`GET /api/company/{companyId}/knowledge`, `/knowledge/status`): their handlers
returned TypeScript interfaces, erased before the Swagger plugin can read
them, so they were published as `Record<string, never>`. `007.02` gave them
DTO classes too (`knowledge-response.dto.ts`).

`src/api/schema.test.ts` now guards both failure modes — a route with no
declared body, and one whose body is an empty object — for every `GET
/api/…` route a component reads, proving its own detector against a sample
before trusting it on the generated schema.

### Where the rest of it is written down

- [ADR-021](ADR-021-web-ui-framework-and-architecture.md) — why TanStack Query
- [ADR-023](ADR-023-backend-api-surface-for-the-web-ui.md) — the API surface,
  and why a consultation is an orphan assignment
- [ADR-025](ADR-025-browser-event-stream-consumption.md) — the stream, the
  cache patching, and the priming the client depends on
- [web-client.md](../web-client.md) — how to use these hooks
