# Phase 02 — web UI: branching and PR workflow

Phase 02 is built up on a long-lived integration branch rather than merged to
`main` a piece at a time, so `main` never carries a half-built web client.

## The branches

| Branch               | From       | Holds                                           |
| -------------------- | ---------- | ----------------------------------------------- |
| `phase-02`           | `main`     | Every completed major index, in order           |
| `p02/<major>_<name>` | `phase-02` | The work for one major index (e.g. `p02/003_…`) |

One working branch per **major index** — `002`, `003`, `004` … — not per prompt.
A major index usually spans several prompts (`003.01`, `003.02`, `003.03`); they
all land on the same branch.

> **Why `p02/` and not `phase-02/`?** Git stores refs as files, so a branch named
> `phase-02` and a branch named `phase-02/003_…` cannot coexist — the first has
> to be a file and the second a directory. `p02/` sidesteps that, and matches the
> prefix already used earlier in this phase.

## The cycle, per major index

1. `git checkout phase-02 && git pull`
2. `git checkout -b p02/<major>_<short-name>`
3. Work through every prompt for that index, committing as you go.
4. When the last prompt for the index is done, **the user opens the PR** into
   `phase-02` — not into `main`, and not by an agent.
5. Merge to `phase-02`, then start the next index from step 1.

### A branch is finished once its PR is squash-merged

**Do not keep working on it.** Squashing puts the index's work on `phase-02` as
one new commit with a new SHA. The branch still holds the originals, and git
cannot tell the two are the same content — so their common ancestor stays the
commit before the index began, both sides look like independent edits to the
same files, and every later PR from that branch conflicts.

It bit 007: `007.01` merged as PR #79, then `007.02` and `007.03` continued on
the same branch and PR #80 arrived conflicting with content identical to its
own. Nothing was lost, and the fix was
`git rebase --onto origin/phase-02 <last-merged-commit>` plus a force-push, but
the conflict looks alarming and explains itself badly.

If a later prompt in the index has to follow a merge, reset first:

```bash
git checkout phase-02 && git pull
git checkout p02/<major>_<short-name>
git reset --hard phase-02      # only when the branch's work is all merged
```

## Closing the phase

When the last major index has merged, a final PR takes `phase-02` into `main`.

**That final merge is not squashed.** Each major index must stay individually
identifiable on `main` — which is the whole reason for the integration branch.
It follows that the per-index PRs into `phase-02` _should_ be squashed, so each
index arrives as one commit and the final merge preserves exactly that sequence.

## Notes for agents

- Never merge to `main`, and never open a PR — the user does both.
- Check you are on the right `p02/…` branch before the first commit of a prompt.
  If the branch does not exist yet, create it from `phase-02`, not from `main`
  and not from the previous index's branch.
- Each prompt's `> **Branch:**` header names the branch that prompt belongs on.
- Every prompt requires a model allocation section in its plan — see
  [model allocation](model-allocation.md).
- Every prompt ends by recording what it leaves open in
  [unresolved notes](../unresolved-notes.md). Work a later prompt will do goes
  **into that prompt**, not only into the plan or this file; anything whose
  trigger is a condition rather than a date needs a memory too, because nothing
  in the repository will prompt anyone to re-check it. A prompt that leaves
  nothing open says so in its plan — silence and "checked, nothing to add" read
  identically afterwards.
