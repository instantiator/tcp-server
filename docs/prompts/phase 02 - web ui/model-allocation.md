# Model allocation

How a plan divides its work between Opus, Sonnet and Haiku sub-agents. Every
phase 02 prompt requires its plan to open with a section applying this.

## The directive

**Default to the cheapest model that can do the step correctly.** Opus decides,
specifies and reviews — it should not be the one typing out work it has already
fully specified.

The plan's model allocation section is a table naming a model for **every**
implementation step:

| Work | Model | Why |
| ---- | ----- | --- |

A step kept by Opus needs a reason in the third column. A step given to Sonnet
or Haiku doesn't.

## What a Sonnet step needs

A step is Sonnet-ready only when the plan already contains all four of:

- **The files.** Exact paths to create or edit, and — where one exists — the
  existing file to copy the pattern from.
- **The decisions.** Names, signatures, token lists, route tables, config keys,
  error shapes: written out. No "choose a sensible X", and no "follow existing
  conventions" without naming the file that holds them.
- **The done-condition.** The command to run, and what passing looks like.
- **The boundary.** What not to touch, plus: when the repo doesn't match the
  plan, stop and report — don't improvise, and never make a failing gate pass by
  changing the assertion.

If a step can't be written to that standard, it isn't a Sonnet step yet. Either
Opus takes the open decision first as its own step and the remainder becomes
Sonnet-ready, or Opus keeps the whole thing.

Writing that detail out is not overhead. It's the specification Opus would have
had to hold in its head anyway, and it's what makes the review cheap.

## What Haiku can take

Steps with no decision left in them, and a mechanical check on the result:

- Enumerated edits — the listed `strings.ts` entries, token declarations, barrel
  exports, `docs/index.md` rows.
- Copy a named file and apply a listed set of substitutions.
- A rename or sweep across an enumerated list of files.
- Running a command and reporting its output verbatim (`check.sh`,
  `run-all-tests.sh`, the audit tool) — reporting only, no diagnosis.

Not Haiku: new logic, tests that assert behaviour, prose that has to be accurate,
or anything where "looks right" and "is right" can differ.

## Review

- **Sonnet is the reviewer of record for mechanical steps** — Haiku's output, and
  Sonnet's own. It checks against the plan's done-condition: does it match the
  spec, does the gate pass, did anything outside the boundary change.
- **Opus reviews** anything touching security, authorisation, accessibility
  behaviour, concurrency or lifecycle, or the shared package's public surface —
  and anything where a sub-agent deviated from the plan or reported a surprise.
- Opus still reads the whole diff before it lands, but a Sonnet-verified
  mechanical diff is a skim, not a line-by-line audit.

## Practical notes

- **Batch.** One sub-agent task per coherent group of files, not one per file.
  Each spawn starts cold and re-derives the context.
- **Take it back after one failed round-trip.** If a sub-agent needs a second
  round of corrective instructions on a step, finish it in Opus rather than
  iterating. That second round is where the economy turns false.
- **Record misallocations.** If a step turned out to be too cheaply allocated,
  note it in the plan, so the next prompt allocates better.
