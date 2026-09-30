#!/usr/bin/env bash
# lib/errors.sh — Say what a script was doing when it failed, and what to try.
#
# Under `set -e` a failing command ends the script with only its own terse
# output (a bare `jq: parse error`, a silent `curl -f`). Call `step` before
# each piece of work, and `enable_error_report` once, and a failure instead
# ends with:
#
#   ✗ Failed while <step> (<file>:<line>)
#     <hint>
#
# `json_field` replaces bare `jq` on anything read from a command or an API:
# when the input isn't JSON, it prints what it was reading and what it got.

CURRENT_STEP=""
CURRENT_HINT=""

# Names the work that follows, with an optional hint for when it fails.
step() {
  CURRENT_STEP="$1"
  CURRENT_HINT="${2:-}"
}

# Installs the ERR trap. `set -E` carries it into functions and subshells.
enable_error_report() {
  set -E
  trap '_report_error "${BASH_SOURCE[0]:-$0}" "$LINENO"' ERR
}

_report_error() {
  local file="$1" line="$2"
  # Report only from the top-level shell. `set -E` also fires the trap inside
  # `$(...)`, even when the caller guards it with `|| true`; the unguarded
  # failure reaches the top level anyway, so this reports it exactly once.
  [[ "$BASH_SUBSHELL" -eq 0 && -n "$CURRENT_STEP" ]] || return 0
  trap - ERR
  echo "" >&2
  echo "✗ Failed while ${CURRENT_STEP} (${file##*/}:${line})" >&2
  [[ -z "$CURRENT_HINT" ]] || echo "  ${CURRENT_HINT}" >&2
}

# Reads JSON on stdin and prints `jq -r <filter>` of it. `what` names the
# source ("the Zitadel project search") for the message when it isn't JSON.
json_field() {
  local what="$1" filter="$2" input
  input="$(cat)"
  # Plain `jq .` accepts empty input, so empty is checked separately.
  if [[ -z "$input" ]] || ! jq . >/dev/null 2>&1 <<<"$input"; then
    {
      echo ""
      echo "✗ Expected JSON from ${what}, but got something else:"
      if [[ -z "$input" ]]; then
        echo "    (nothing — the command printed no output)"
      else
        head -20 <<<"$input" | sed 's/^/    /'
      fi
      echo "  Anything above that isn't JSON (build output, an HTML error page, a"
      echo "  log line) was mixed into the response."
    } >&2
    return 1
  fi
  jq -r "$filter" <<<"$input"
}
