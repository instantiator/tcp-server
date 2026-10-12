# ADR-036: Customer Data Protection for Record Tables

**Status:** Implemented (2026-10-12) — delivered by 001.04 (phase 04)

## Context

Agents keep orders in record tables ([tcp-mcp-records](../tcp-mcp-records.md)), which means names, addresses and emails of members of the public. Nothing limited how long those rows lived, nobody could find everything held about one person, and nothing stopped an agent storing someone who had asked not to be kept on file. The [usage gaps](../prompts/phase%2004%20-%20utility/usage.gaps.md#customer-data-protection) asked for retention per table, find-and-delete, export for subject access requests, and a non-advisory note on data protection duties.

## Decision

- **A do-not-store list per company**, kept in the records database (`record_do_not_store`) so the records server checks every agent write without a network call.
  - **Matching:** a text field matches when it contains an entry as a whole word or phrase, ignoring case, spacing and accents. "Ann Lee" matches "Deliver to ann lee, 3 High St"; "Ann" doesn't match "Annual". Entries need three characters, including a letter or digit.
  - **Agents are refused.** `insert`/`update` store nothing and tell the agent which fields matched, not to try another spelling, and to fail its assignment with `data_protection` if it can't do without them. Agents can add to the list (`do_not_store`) but not read, change or remove it.
  - **People are warned, not stopped.** Their edits get a 409 `do_not_store`; the web client asks, then repeats with `confirmDoNotStore=true`, which is audited by field name.
- **Retention per table:** `{days, from}`, from the row's last change or a date field. Whole rows are deleted by an hourly sweep in tcp-server. Blank or non-date values are kept. Set by people only.
- **Search across every table** (a substring match, deliberately broader than blocking), with export and delete of any selection: one sheet per table, one CSV per table.
- **New audit events carry ids, counts and field names, never values or list entries.** The audit log is not erased with the rows, so it mustn't collect what they held.
- **Scope is record tables only, and the UI says so.** The audit log, transcripts, knowledge, resources, files, memory and backups are not searched or erased.
- **The note on duties** sits at the top of the Data protection tab, links to the ICO's own page, and gives no advice. It moves into company templates when they exist.

## Alternatives considered

- **Substring blocking.** Simplest, but a short entry would block unrelated records.
- **Exact field values.** Misses a name inside an address or a note.
- **Agents may read the list.** Rejected: it would put the list into model context, possibly a remote provider's.
- **Erasing audit and transcripts too.** Rejected for now: the audit log is append-only by design ([ADR-008](ADR-008-audit-logging.md)); tracked in [outstanding-issues.md](../outstanding-issues.md#data-protection-reaches-record-tables-only).
- **Field-level retention** (blank the address, keep the order). Most faithful to the example, deferred: whole rows cover the common case.

## Consequences

- An entry added at the moment of a write can miss that one write (the check is outside the write's transaction).
- Backups keep deleted rows until they rotate.
- A cross-table delete is one request per table, so a failure part-way leaves earlier tables' deletions done.
