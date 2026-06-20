import * as readline from 'readline';
import { apiRequest, ApiOptions } from './api';

/** Options that control how a token is obtained. */
export interface AuthOptions {
  baseUrl: string;
  accessToken?: string;
  accessTokenEnvVar?: string;
  username?: string;
  password?: string;
}

/** Resolves a bearer token from the provided options, prompting if needed. */
export async function resolveToken(opts: AuthOptions): Promise<string> {
  // 1. Explicit token
  if (opts.accessToken) return opts.accessToken;

  // 2. Environment variable
  if (opts.accessTokenEnvVar) {
    const val = process.env[opts.accessTokenEnvVar];
    if (!val) {
      process.stderr.write(
        `Error: env var ${opts.accessTokenEnvVar} is not set\n`,
      );
      process.exit(1);
    }
    return val;
  }

  // 3. Username + password grant via server
  if (!opts.username) {
    process.stderr.write(
      'Error: provide --access-token, --access-token-env-var, or --username\n',
    );
    process.exit(1);
  }

  const password =
    opts.password ?? (await promptPassword(`Password for ${opts.username}: `));

  const apiOpts: ApiOptions = { baseUrl: opts.baseUrl };
  const data = await apiRequest<{ access_token: string }>(
    apiOpts,
    'POST',
    '/api/auth/token',
    { username: opts.username, password },
  );
  return data.access_token;
}

/** Prompts for a password, masking each character with `*`. */
function promptPassword(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    // Mask typed characters
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput =
      (s: string) => {
        if (s === '\r\n' || s === '\n' || s === '\r') {
          process.stdout.write('\n');
        } else if (s.length > 0) {
          process.stdout.write('*');
        }
      };

    process.stdout.write(prompt);
    rl.question('', (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
