#!/usr/bin/env bash
# manual-verify.sh — interactive manual verification script.
#
# Spins up a test company and two roles (chicken/cat assistant) against a
# running TCP server, runs a short scenario of chat prompts through them, and
# asks the operator to confirm each response by eye. Halts immediately on any
# failure (a failed API call, missing data, or a "n" answer to a check).
#
# Usage: ./scripts/manual-verify.sh [OPTIONS]
#
# Logs in once via `tcp-cli get-token`'s device-flow login (prints a
# verification URL/code for you to complete in a browser) before running any
# scenarios, then reuses that token for every call.
#
# Options:
#   -s, --tcp-server <url>         TCP server URL (default: http://localhost:3000)
#   -r, --run-scenario <n>         Run only scenario n (1-indexed); may be repeated
#   -f, --scenarios-file <f>       Scenarios JSON (default: scripts/test-data/manual-verify-scenarios.json)
#   --capture-docker-logs          Tail tcp-server and tcp-agent container logs during the run
#   --docker-logs-output <file>    File to write Docker logs to (default: ./tcp-docker-logs-<ts>.log)
#   --docker-project <name>        Docker Compose project name (default: tcp-dev)
#   --capture-lm-studio-logs       Stream LM Studio server logs via `lms log stream`
#   --lm-studio-logs-output <file> File to write LM Studio logs to (default: ./tcp-lmstudio-logs-<ts>.log)
#
# Prerequisites: a running TCP stack with default LLM config in its .env,
# Zitadel running for auth, and `jq` on the PATH.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"

# ANSI colours for operator-facing output. Empty when stdout is not a TTY so
# piped/captured logs stay clean.
if [[ -t 1 ]]; then
  BLUE=$'\e[34m'
  YELLOW=$'\e[33m'
  GREEN=$'\e[32m'
  RED=$'\e[31m'
  RESET=$'\e[0m'
else
  BLUE=""
  YELLOW=""
  GREEN=""
  RED=""
  RESET=""
fi

TCP_SERVER="http://localhost:3000"
SCENARIOS_FILE="$ROOT/scripts/test-data/manual-verify-scenarios.json"
SCENARIO_FILTER=()
CAPTURE_DOCKER_LOGS=false
DOCKER_LOGS_OUTPUT=""
DOCKER_PROJECT="tcp-dev"
DOCKER_LOG_PIDS=()
CAPTURE_LM_STUDIO_LOGS=false
LM_STUDIO_LOGS_OUTPUT=""
LM_STUDIO_LOG_PID=""

# Parse flags — everything else is rejected rather than silently ignored.
while [[ $# -gt 0 ]]; do
  case "$1" in
    -s|--tcp-server) TCP_SERVER="$2"; shift 2 ;;
    -r|--run-scenario) SCENARIO_FILTER+=("$2"); shift 2 ;;
    -f|--scenarios-file) SCENARIOS_FILE="$2"; shift 2 ;;
    --capture-docker-logs) CAPTURE_DOCKER_LOGS=true; shift ;;
    --docker-logs-output) DOCKER_LOGS_OUTPUT="$2"; shift 2 ;;
    --docker-project) DOCKER_PROJECT="$2"; shift 2 ;;
    --capture-lm-studio-logs) CAPTURE_LM_STUDIO_LOGS=true; shift ;;
    --lm-studio-logs-output) LM_STUDIO_LOGS_OUTPUT="$2"; shift 2 ;;
    *) echo "ERROR: unknown flag: $1" >&2; exit 1 ;;
  esac
done

[[ -f "$SCENARIOS_FILE" ]] || { echo "ERROR: scenarios file not found: $SCENARIOS_FILE" >&2; exit 1; }
command -v jq >/dev/null || { echo "ERROR: jq is required but not installed" >&2; exit 1; }

# When --capture-docker-logs is set, tail both service containers into a log file
# for the duration of the run so failures can be reviewed after the fact.
start_docker_capture() {
  if [[ "$CAPTURE_DOCKER_LOGS" != "true" ]]; then return; fi
  if [[ -z "$DOCKER_LOGS_OUTPUT" ]]; then
    DOCKER_LOGS_OUTPUT="$(pwd)/tcp-docker-logs-$(date +%Y%m%d-%H%M%S).log"
  fi
  echo "Docker logs → $DOCKER_LOGS_OUTPUT" >&2
  local since
  since=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  docker logs -f --since "$since" "${DOCKER_PROJECT}-tcp-server-1" 2>&1 \
    | sed -u 's/^/[tcp-server] /' >> "$DOCKER_LOGS_OUTPUT" &
  DOCKER_LOG_PIDS+=($!)
  docker logs -f --since "$since" "${DOCKER_PROJECT}-tcp-agent-1" 2>&1 \
    | sed -u 's/^/[tcp-agent] /' >> "$DOCKER_LOGS_OUTPUT" &
  DOCKER_LOG_PIDS+=($!)
}

stop_docker_capture() {
  for pid in "${DOCKER_LOG_PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
}

start_lm_studio_capture() {
  if [[ "$CAPTURE_LM_STUDIO_LOGS" != "true" ]]; then return; fi
  command -v lms >/dev/null || { echo "ERROR: lms CLI not found — cannot capture LM Studio logs" >&2; exit 1; }
  if [[ -z "$LM_STUDIO_LOGS_OUTPUT" ]]; then
    LM_STUDIO_LOGS_OUTPUT="$(pwd)/tcp-lmstudio-logs-$(date +%Y%m%d-%H%M%S).log"
  fi
  echo "LM Studio logs → $LM_STUDIO_LOGS_OUTPUT" >&2
  lms log stream --source server >> "$LM_STUDIO_LOGS_OUTPUT" 2>&1 &
  LM_STUDIO_LOG_PID=$!
}

stop_lm_studio_capture() {
  [[ -n "$LM_STUDIO_LOG_PID" ]] && kill "$LM_STUDIO_LOG_PID" 2>/dev/null || true
}

# Wraps tcp-cli.sh with auth/server flags pre-filled, so every call site below
# only needs to specify the verb and its own flags.
cli() {
  "$ROOT/tcp-cli.sh" \
    --tcp-server "$TCP_SERVER" \
    --access-token "$ACCESS_TOKEN" \
    "$@"
}

# Prints a failure message and halts the script immediately (exit 1).
fail() {
  echo "" >&2
  echo "${RED}FAIL: $1${RESET}" >&2
  exit 1
}

# Returns 0 (true) when the given 1-indexed scenario number should run.
# With no filter all scenarios pass; with a filter only listed numbers pass.
scenario_selected() {
  local n="$1"
  [[ ${#SCENARIO_FILTER[@]} -eq 0 ]] && return 0
  for f in "${SCENARIO_FILTER[@]}"; do
    [[ "$f" == "$n" ]] && return 0
  done
  return 1
}

# Presents one yes/no check to the operator and compares the answer against the
# expected outcome (default "y"). A mismatch halts the script via fail(); a
# match prints a green "Success" before the next question. This lets a scenario
# assert that the answer to some checks should be "n".
ask_yn() {
  local question="$1"
  local expected="${2:-y}"
  echo ""
  local answer
  read -rn 1 -p "  ${YELLOW}CHECK: $question [y/n]${RESET} " answer
  echo ""
  if [[ "$answer" == "$expected" ]]; then
    echo "  ${GREEN}Success${RESET}"
  else
    fail "Check failed (expected '$expected'): $question"
  fi
}

trap 'stop_docker_capture; stop_lm_studio_capture' EXIT

# Log in once via device-flow (prints a verification URL/code to complete in
# a browser) and reuse the resulting token for every cli() call below.
echo "${BLUE}=== Signing in ===${RESET}" >&2
ACCESS_TOKEN=$("$ROOT/tcp-cli.sh" --tcp-server "$TCP_SERVER" get-token) \
  || fail "get-token failed"

start_docker_capture
start_lm_studio_capture

# Step 1: create the test company from fixture JSON, then confirm it round-trips
# through list-companies before trusting its id for the steps that follow.
echo "${BLUE}=== 1. Creating test company ===${RESET}"
COMPANY_JSON=$(cat "$ROOT/scripts/test-data/companies/simple-company.json" | cli set-company) \
  || fail "set-company failed"
COMPANY_ID=$(jq -r '.id' <<< "$COMPANY_JSON")
[[ -n "$COMPANY_ID" && "$COMPANY_ID" != "null" ]] || fail "set-company response had no id: $COMPANY_JSON"
echo "Company created: $COMPANY_ID"

cli list-companies | jq -e --arg id "$COMPANY_ID" \
  'map(select(.id == $id)) | length > 0' >/dev/null \
  || fail "company $COMPANY_ID not found in list-companies"

# Step 2: create the chicken assistant role under that company, same
# create-then-verify pattern as step 1.
echo ""
echo "${BLUE}=== 2. Creating chicken assistant role ===${RESET}"
CHICKEN_JSON=$(cat "$ROOT/scripts/test-data/roles/chicken-assistant.json" \
  | cli set-role --company-id "$COMPANY_ID") || fail "set-role (chicken) failed"
CHICKEN_ROLE_ID=$(jq -r '.id' <<< "$CHICKEN_JSON")
[[ -n "$CHICKEN_ROLE_ID" && "$CHICKEN_ROLE_ID" != "null" ]] || fail "set-role (chicken) response had no id: $CHICKEN_JSON"
echo "Chicken role created: $CHICKEN_ROLE_ID"

cli list-roles --company-id "$COMPANY_ID" | jq -e --arg id "$CHICKEN_ROLE_ID" \
  '.[0].roles | map(select(.id == $id)) | length > 0' >/dev/null \
  || fail "chicken role $CHICKEN_ROLE_ID not found in list-roles"

# Step 3: same as step 2, for the cat assistant role — needed so the chicken
# (step 2) has someone to recommend consulting, and the cat (here) has someone
# to actually consult in the scenarios below.
echo ""
echo "${BLUE}=== 3. Creating cat assistant role ===${RESET}"
CAT_JSON=$(cat "$ROOT/scripts/test-data/roles/cat-assistant.json" \
  | cli set-role --company-id "$COMPANY_ID") || fail "set-role (cat) failed"
CAT_ROLE_ID=$(jq -r '.id' <<< "$CAT_JSON")
[[ -n "$CAT_ROLE_ID" && "$CAT_ROLE_ID" != "null" ]] || fail "set-role (cat) response had no id: $CAT_JSON"
echo "Cat role created: $CAT_ROLE_ID"

cli list-roles --company-id "$COMPANY_ID" | jq -e --arg id "$CAT_ROLE_ID" \
  '.[0].roles | map(select(.id == $id)) | length > 0' >/dev/null \
  || fail "cat role $CAT_ROLE_ID not found in list-roles"

# Step 4: walk the scenarios file — for each entry, resolve its role key to the
# id created above, send the prompt via a single-query chat session, then ask
# the operator every check listed for that prompt before moving on.
echo ""
echo "${BLUE}=== 4. Running scenarios ===${RESET}"
SCENARIO_COUNT=$(jq 'length' "$SCENARIOS_FILE")
for i in $(seq 0 $((SCENARIO_COUNT - 1))); do
  scenario_selected $((i + 1)) || continue

  ROLE_KEY=$(jq -r ".[$i].role" "$SCENARIOS_FILE")
  PROMPT=$(jq -r ".[$i].prompt" "$SCENARIOS_FILE")

  case "$ROLE_KEY" in
    chicken) ROLE_ID="$CHICKEN_ROLE_ID" ;;
    cat) ROLE_ID="$CAT_ROLE_ID" ;;
    *) fail "unknown role key in scenarios file: $ROLE_KEY" ;;
  esac

  echo ""
  echo "${BLUE}--- Scenario $((i + 1))/$SCENARIO_COUNT — [$ROLE_KEY] $PROMPT ---${RESET}"
  cli chat --role-id "$ROLE_ID" --query "$PROMPT" || fail "chat request failed for scenario $((i + 1))"

  CHECK_COUNT=$(jq ".[$i].checks | length" "$SCENARIOS_FILE")
  for j in $(seq 0 $((CHECK_COUNT - 1))); do
    CHECK_TEXT=$(jq -r ".[$i].checks[$j].question" "$SCENARIOS_FILE")
    CHECK_EXPECTED=$(jq -r ".[$i].checks[$j].expected // \"y\"" "$SCENARIOS_FILE")
    ask_yn "$CHECK_TEXT" "$CHECK_EXPECTED"
  done
done

echo ""
echo "${GREEN}=== All scenarios passed ===${RESET}"
