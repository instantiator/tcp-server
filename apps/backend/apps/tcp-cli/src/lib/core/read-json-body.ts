import { readStdin } from './stdin';

/**
 * Reads a JSON object body from `--input` (when given) or stdin — the shared
 * shape behind every `set-*` verb (`set-company`, `set-role`, `set-task`).
 * Exits the process with an error message if the input isn't valid JSON or
 * isn't an object.
 */
export async function readJsonBody(cmdOpts: {
  input?: string;
}): Promise<Record<string, unknown>> {
  const raw = cmdOpts.input ?? (await readStdin());
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    process.stderr.write('Error: input must be a JSON object\n');
    process.exit(1);
  }
  return parsed as Record<string, unknown>;
}
