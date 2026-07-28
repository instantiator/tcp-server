#!/bin/bash
set -e
# Create extra databases needed by other services.
# The primary database ($POSTGRES_DB = "tcp") is created automatically by the postgres image.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE DATABASE zitadel;
EOSQL
