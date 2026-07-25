import { existsSync, readFileSync } from 'node:fs';

/**
 * Reads a simple `KEY=value` env file and returns a record of all variables.
 *
 * Handles blank lines, comments (`#`), and unquoted values. Values may contain
 * `=` signs (only the first `=` is used as the separator). Lines with no `=`
 * are silently skipped.
 */
export function parseEnvFile(filePath: string): Record<string, string> {
  const content = readFileSync(filePath, 'utf8');
  const result: Record<string, string> = {};

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const separator = line.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    result[key] = value;
  }

  return result;
}

/**
 * Loads an env file into {@link process.env}, without overwriting variables
 * that are already set. Returns the parsed record for inspection or forwarding.
 */
export function loadEnvFile(
  filePath: string,
  options?: { overwrite?: boolean },
): Record<string, string> {
  const parsed = parseEnvFile(filePath);
  for (const [key, value] of Object.entries(parsed)) {
    if (options?.overwrite || process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return parsed;
}

/**
 * Loads a committed env file layered with its gitignored `<file>.local`
 * override, mirroring how the deployment scripts layer config. Precedence:
 * values already in `process.env` (an explicit caller export) win, then the
 * `.local` file, then the committed base. The `.local` sibling holds
 * generated/provider-issued secrets (`LOCAL_ONLY_ENV_KEYS` — e.g.
 * `TEST_CLIENT_ID/SECRET`) that must not be committed; a missing `.local` is a
 * no-op. Returns the merged file values (before the process.env guard).
 */
export function loadEnvFileWithLocal(filePath: string): Record<string, string> {
  const base = parseEnvFile(filePath);
  const localPath = `${filePath}.local`;
  const local = existsSync(localPath) ? parseEnvFile(localPath) : {};
  const merged = { ...base, ...local };
  for (const [key, value] of Object.entries(merged)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return merged;
}
