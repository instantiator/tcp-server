# Prompts

This is an archive of initial prompts and plans - created in planning mode, documenting the high-level process of each piece of work initiated.

It's worth noting that the tests regularly evolved by conversation with the coding assistant, and that a lot of smaller pieces of work were conducted after each large plan has been executed - either bug fixing, code quality improvements, or modifications to code behaviour and scripts.

## Structure

Prompts are grouped into phase directories, each with its own numbering starting at `001.1`:

- `phase 01 - service/` - the core service build-out (lcp-server, lcp-agent, MCP servers, shared library).
- `phase 02 - web ui/` - reserved for a future web UI phase.
- `phase 03 - service quality/` - standalone future-work items (security/ethics review, configurable third-party services, accessibility/i18n, Strands evaluation) not yet broken into sub-plans.

A prompt numbered `N.1` is typically the original high-level ask; sub-plans generated from it are numbered `N.1.1`, `N.1.2`, etc.
