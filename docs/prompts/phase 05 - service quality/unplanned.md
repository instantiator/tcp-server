- need a way to create companies through the web ui

- web ui: account / sign out: automatically signs straight back in again - should probably redirect to an inert page

- create `CONTRIBUTING.md`

- what happens when the backend has completed something but the frontend is catching up - do errors occur if the user attempts an interaction (eg.) for an agent that no longer exists?

- how can we design configurable workflows, eg. provide one or more ways of working in a file format that can be interpreted
  - this starts as design work
  - examples of things it should be able to do...
    - parallel working
    - iterative refinement loops
    - conditional steps (given role or the planner decides)
    - branching steps (given role or the planner decides)
    - add/remove/modify items in the plan
    - user steps (specific users, groups of users, open asks)

- MCP tools are usable, but not easily configurable
  - manage roles: add and remove MCP configurations
    - both TUI and UI
    - use a common format
    - offer a library of known MCP services
      - API
      - TUI
      - web ui should have a nice catalog interface
        - searchable

- the isometric view should be 'skinnable'
  - basics: roles should be adjustable (sprites / colour schemes)
  - furniture should be adjustable (sprites / colour schemes)
  - environment colour schemes
  - environment decorations
  - offer some basic skins
    - default minimal (as now - cuboids)
    - TCP (pixelated sprites)
