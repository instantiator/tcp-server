* `setup-wizard.sh` offers a connectivity check for the LLM provider - it'd be good to break that out into an independent tool

```
 companies...
[tcp-cli] Building tcp-cli...
jq: parse error: Invalid numeric literal at line 2, column 2
```

* setup wizard should offer configurations for popular inference providers out of the box
  - Offer a choice between some 'templated' providers or allow the user to enter their own details
    - remote...
      - openai
      - openai compatibles (is there a known list?)
      - anthropic
      - google
    - local...
      - lmstudio
      - other standard options?

* need a way to create companies through the web ui

* web ui: account / sign out: automatically signs straight back in again - should probably redirect to an inert page

* create `CONTRIBUTING.md`

* what happens when the backend has completed something but the frontend is catching up - do errors occur if the user attempts an interaction (eg.) for an agent that no longer exists?

* let's link minio / silo to the OIDC service of choice
  * add a synchronisation feature - when a user is granted access to a company, they are granted access to that company's bucket (and revoked if no longer the case)

* how can we design configurable workflows, eg. provide one or more ways of working in a file format that can be interpreted
  * this starts as design work
  * examples of things it should be able to do...
    * parallel working
    * iterative refinement loops
    * conditional steps (given role or the planner decides)
    * branching steps (given role or the planner decides)
    * add/remove/modify items in the plan
    * user steps (specific users, groups of users, open asks)

* MCP tools are usable, but not easily configurable
  * manage roles: add and remove MCP configurations
    * both TUI and UI
    * use a common format
    * offer a library of known MCP services
      * API
      * TUI
      * web ui should have a nice catalog interface
        * searchable

* the isometric view should be 'skinnable'
  * basics: roles should be adjustable (sprites / colour schemes)
  * furniture should be adjustable (sprites / colour schemes)
  * environment colour schemes
  * environment decorations
  * offer some basic skins
    * default minimal (as now - cuboids)
    * TCP (pixelated sprites)
