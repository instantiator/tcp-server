#!/bin/bash

# init test-company
./tcp-cli.sh -u test -p test set-company < scripts/test-data/companies/simple-company.json
./tcp-cli.sh -u test -p test set-role -c test-company < scripts/test-data/roles/chicken-assistant.json
./tcp-cli.sh -u test -p test set-role -c test-company < scripts/test-data/roles/cat-assistant.json

# set the planner role
./tcp-cli.sh -u test -p test set-planner -c test-company -r cat-assistant

# start a task
# get the task id from the call
TASK_ID=$(./tcp-cli.sh \
  -u test -p test create-task \
  -c test-company \
  -r "Create a short report on games that cats and chickens can play together." \
  -e "cat-chicken-games.md" \
  --start | jq -r '.id')

# review the task
./tcp-cli.sh -u test -p test get-task --task-id "$TASK_ID"

# eavesdrop on the task
./tcp-cli.sh -u test -p test eavesdrop --task-id "$TASK_ID" --show-history --tail
