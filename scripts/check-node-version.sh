#!/usr/bin/env bash
# Fails when the running Node differs from the version .nvmrc pins.
#
# This exists because the failure it prevents is unreadable. Native modules
# (better-sqlite3) are compiled against one Node ABI at install time. Run the
# suite under a different major and the binding refuses to load, TypeORM's
# connection retries then blow every 5s `beforeAll` budget, and Jest reports
# ~200 failing tests plus a wall of "require after teardown" — none of which
# names the actual problem.
#
# It bites through the git hooks specifically: they inherit whatever shell
# invoked git, and nvm's `default -> lts/*` can easily be a major behind the
# pin while `nvm use` in a terminal is correct. That difference is invisible
# until something native loads.
set -euo pipefail

TOP="$(git rev-parse --show-toplevel)"
[[ -f "$TOP/.nvmrc" ]] || exit 0

want="$(tr -d '[:space:]' <"$TOP/.nvmrc")"
# Only a literal version is checkable. An alias (lts/*, node) is nvm's to
# resolve, and guessing at it would fail people for no reason.
[[ "$want" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 0

have="$(node -v 2>/dev/null || true)"
have="${have#v}"
[[ -n "$have" ]] || exit 0
[[ "$have" != "$want" ]] || exit 0

cat >&2 <<EOF

✗ Node $have is running, but .nvmrc pins $want.

  Native modules were built for $want and will not load under $have.
  You would see ~200 failing tests and a wall of "require after teardown",
  none of it pointing here.

  Fix:  nvm use          # in $TOP

  Your shell's nvm default may be behind the pin — check with:
        nvm alias default

EOF
exit 1
