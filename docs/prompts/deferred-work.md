## Unplanned, missing features

### Company definitions as zip files

- Contains a company
- Contains roles
- Contains knowledge
- tcp-cli can unzip and set company, roles, and knowledge for roles
- probably roles will need a way to declare the source files to use

### Default admin user provision

- Currently we provide a test user in config
- We need a way to easily assign an admin user
- If using provided Zitadel, it should be possible to create or assign the admin user through tcp-cli
- If using an external OIDC service, it should be easy to assign the admin user through tcp-cli or config (and the creation of the admin user is an exercise for the owner of the OIDC service)

### Grouping components by visual style

- Three views are planned over the same hooks: plain, arranged, illustrated
- Nothing arranges the codebase for that yet

### The most recent event, per entity

- `applyEvent` extracts `summary` and discards the raw event, so "what just changed" is not available
- Exposing it needs a design decision: a cache entry per entity, or a separate map, and whether it is the raw `AuditWireEvent` or something normalised
- Its purpose was triggering animations, and a component can get there by diffing its own previous state — so this is deferred rather than dropped

### Connection monitoring and auto-reconnect

If the service is not reachable, this should be shown to the user in the UI as a warning. Similarly, if the internet connection is offline, that should be shown to the user. These are different warnings. The user really only _needs_ to know about the service availability, but the internet connection is an extra piece of information.

When disconnected, the UI should poll to determine if it has become available again. (NB. because it's possible the system is running locally, polling is preferred to just relying on the internet connectivity.) If the service becomes available again, required SSE endpoints should be automatically reconnected. Similarly, if internet availability goes from unavailable to available, this reconnection should be triggered immediately.

### System health monitoring

System health is available through the `/health` endpoint.

Add a `get-health` verb to tcp-cli which retrieves and prints the json object from the tcp-server's `/health` endpoint (formatted).

If no other options are provided, it should assume tcp-server's `/health` endpoint. Otherwise it should be able to retrieve a selected app's health data - ie. `--app tcp-server`, `--app tcp-agent`, etc.

At the moment, there's an "account" menu in the UI. We should add a "system" menu. For now, that can have a single entry for system health, which opens a simple dialog containing the JSON response from the tcp-server `/health` endpoint.

### Connection monitoring

We ought to show a connection indicator in the CLI - ie. noting whether the backend is reachable. This is _probably_ easiest done by monitoring for at least 1x SSE connection. (Is there an SSE connection from the )

At current time there's no need for an automatic reconnect (unless that's easy to implement). If not implemented now, we should plan it into future work. We track the very basics of this as notes in `deferred-phases.md`

Interactive features that would invoke the API should be disabled until connection is resumed, although navigation should still be permitted - ie. it should be possible to show cached data about tasks, conversations, the company, etc. but "Send message" buttons, or "Complete conversation" buttons, etc. should be disabled.

Caveat: When re-enabling items, their component should have final say on whether they are really enabled. eg.

- Send message button in a conversation: may be disabled already because the agent is busy responding
- Connectivity switches to offline, all connection-sensitive buttons (including this) are disabled
- Connectivity resumes: Send message button should only be enabled if it would be ordinarily (ie. if the conversation has completed)

The best approach is still an open question:

We should find a way to do this consistently and as DRY as possible. Ideally we wouldn't write extra code for every component with an interaction element - and instead we can mark components that need to do this (eg. with a CSS class or custom property) and have the rules applied for us. That may mean tracking "logically enabled" and "connectivity sensitive" on each affected element, and then calculating the real enabled value for each affected element based on that.

### Rich failure messages

If a chat cannot be opened, the message shown is: "This conversation could not be loaded."

It would be helpful to offer slightly more context, as bullets explaining the initial failure. Some examples might be:

> This conversation could not be loaded.
>
> - The database was not reachable.
> - No audit data exists in the database for agent with id: ${agentId}
> - No assignment exists in the database with id: ${assignmentId}

Similarly, on attempting to complete the same conversation: "This chat could not be completed. Try again."

Again, slightly more context would be helpful, as bullets after the error. Some examples: eg.

> This chat could not be completed. Try again.
>
> - The database was not reachable.
> - No assignment exists in the database with id: ${assignmentId}
> - You do not have permission to alter assignment with id: ${assignmentId}

(I appreciate there probably isn't a "no permission" scenario yet for this. It's illustrative.)

### Theme controls

The theme controls should be available on every page. Currently they're available on the landing page only. As they're required for accessibility, we should ensure they're available on every page.

### Office view: real art and taller walls

The office view (000.01) draws placeholder shapes — Phaser `isobox`es and polygons, no asset files. Two follow-ups:

- Real sprite art for rooms, furniture and avatars, replacing the placeholder shapes.
- Tall walls with a cut-away view, so a room reads as a room rather than a low kerb. Walls are short today specifically so they never hide a walking avatar; a cut-away (showing the near walls but not the far ones, as in most isometric games) would let walls be tall without that problem.

### Office view: tray actions

The tray's role, task and agent panels are read-only. They should let the user act on what they are looking at:

- Open the task dialog from the task panel.
- Start a chat with a role from the role panel, via `useChat().startChat`.

These replace the `TODO(000.01)` handlers the old placeholder visualisation had for opening a task and starting a chat.

### Office view: lazy-load Phaser

The web client's main bundle is about 2 MB, and Phaser is imported statically through `CompanyPage`, so every page pays for it even when the office view is never opened. Phaser should load lazily, only when the visualisation tab is shown.

### Office view: zoom

The office view has no way to zoom in or out. Panning works (toolbar buttons, arrow keys, and dragging the canvas since phase 03's 005.01), but zooming would make a large office easier to navigate.

### Office view: rooms that outgrow their slot

Every room occupies one fixed-size slot (`ROOM_WIDTH = 9`, `ROOM_HEIGHT = 7`). A room with more going on than the slot can furnish — more roles than the rec room's spots, more concurrent avatars than a task room's desks — has no way to grow. Today that means two ceilings, both marked `ponytail:` in `world/furnishing.ts`: the rec room has 28 role spots (a 29th role isn't placed at all), and a task room has at most 8 desks (a 9th avatar stands by the whiteboard).
