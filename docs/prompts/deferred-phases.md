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
