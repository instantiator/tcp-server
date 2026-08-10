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
