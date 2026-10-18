#!/bin/bash

# `-u`/`-p` (password grant) no longer exist — the OIDC provider only supports
# the device-authorization flow (see apps/backend/apps/tcp-cli/src/lib/auth/token.ts).
# This is a manual/interactive script, so authenticate once via a browser and
# reuse the token for every call below.
TOKEN=$(./tcp-cli.sh get-token)

# init test-company (the chicken and cat assistants), replacing any earlier copy
./tcp-cli.sh -t "$TOKEN" import-company scripts/test-data/templates/test-company --replace

# set the planner role
./tcp-cli.sh -t "$TOKEN" set-planner -c test-company -r cat-assistant

# start a task
# get the task id from the call
TASK_ID=$(./tcp-cli.sh \
  -t "$TOKEN" create-task \
  -c test-company \
  -r "Create a short report on games that cats and chickens can play together." \
  -e "cat-chicken-games.md" \
  --start | jq -r '.id')

# review the task
./tcp-cli.sh -t "$TOKEN" get-task --task-id "$TASK_ID"

# eavesdrop on the task
./tcp-cli.sh -t "$TOKEN" eavesdrop --task-id "$TASK_ID" --show-history --tail
