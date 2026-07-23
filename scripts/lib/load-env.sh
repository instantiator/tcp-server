#!/usr/bin/env bash
# lib/load-env.sh — Load env files with precedence (first value wins).

# Usage: load_env_files <file1> [file2] [file3] ...
# Later files provide fallbacks; earlier files take precedence.
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
