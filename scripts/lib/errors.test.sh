#!/usr/bin/env bash
# errors.test.sh — Checks lib/errors.sh says what failed and quotes bad input.
# Run by run-unit-tests.sh.
set -euo pipefail

LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/errors.sh"
failures=0

# Runs a script body with errors.sh loaded; prints its combined output.
run() {
  bash -c "set -euo pipefail; source '$LIB'; enable_error_report; $1" 2>&1 || true
}

expect() {
  local name="$1" output="$2" needle="$3"
  if [[ "$output" != *"$needle"* ]]; then
    echo "FAIL: $name — expected to find: $needle" >&2
    printf '%s\n' "$output" >&2
    failures=$((failures + 1))
  fi
}

# The original bug: npm's build banner captured ahead of tcp-cli's JSON.
out="$(run "step 'creating a company' 'try again'; x=\$(printf '\n> tcp-server build\n{}' | json_field 'tcp-cli set-company' .id)")"
expect "names the source" "$out" "Expected JSON from tcp-cli set-company"
expect "quotes the input" "$out" "> tcp-server build"
expect "names the step" "$out" "Failed while creating a company"
expect "gives the hint" "$out" "try again"

out="$(run "json_field 'an empty reply' . </dev/null")"
expect "reports empty input" "$out" "the command printed no output"

out="$(run "echo '{\"id\":\"abc\"}' | json_field 'good JSON' .id")"
expect "reads valid JSON" "$out" "abc"

# A guarded failure (`|| true`) stays quiet.
out="$(run "step 'guarded'; x=\$(false) || true; echo done")"
[[ "$out" == "done" ]] || { echo "FAIL: guarded failure reported: $out" >&2; failures=$((failures + 1)); }

# An unguarded failure is reported exactly once.
out="$(run "step 'once'; x=\$(false)")"
count="$(grep -c 'Failed while once' <<<"$out" || true)"
[[ "$count" == 1 ]] || { echo "FAIL: expected one report, got $count" >&2; failures=$((failures + 1)); }

if [[ "$failures" -gt 0 ]]; then
  echo "errors.test.sh: $failures failure(s)" >&2
  exit 1
fi
echo "errors.test.sh: all passed"
