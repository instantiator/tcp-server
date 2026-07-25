#!/usr/bin/env bash
# lib/load-env.sh — Load env files in order; later files override earlier.

# Usage: load_env_files <file1> [file2] [file3] ...
# Files are sourced in the order given, so a variable set in a later file
# overrides the same variable from an earlier one (last value wins). Pass the
# committed base file first and its `.local` override last.
load_env_files() {
  local loaded=()
  for file in "$@"; do
    if [[ -f "$file" ]]; then
      # shellcheck disable=SC1090
      source "$file"
      loaded+=("$file")
    fi
  done
  echo "Loaded env files: ${loaded[*]}" >&2
}
