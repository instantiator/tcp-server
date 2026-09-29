* `setup-wizard.sh` offers a connectivity check for the LLM provider - it'd be good to break that out into an independent tool

* create `CONTRIBUTING.md`

* setup wizard should offer configurations for popular inference providers out of the box

* what happens when the backend has completed something but the frontend is catching up - do errors occur if the user attempts an interaction (eg.) for an agent that no longer exists?

* let's link minio / silo to the OIDC service of choice
  * add a synchronisation feature - when a user is granted access to a company, they are granted access to that company's bucket (and revoked if no longer the case)

* how can we design configurable workflows, eg.
  * parallel working
  * iterative refinement loops

* MCP tools are usable, but not easily configurable
  * manage roles: add and remove MCP configurations
    * both TUI and UI
    * use a common format

* the isometric view should be 'skinnable'
  * basics: roles should be adjustable (sprites / colour schemes)
  * furniture should be adjustable (sprites / colour schemes)
  * environment colour schemes
  * environment decorations
