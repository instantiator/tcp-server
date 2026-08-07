import * as readline from 'readline';

/**
 * Prompts the user with a yes/no question on stdin/stdout, resolving `true`
 * for `y`/`yes` (case-insensitive) and `false` for anything else.
 */
export function confirmAction(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    rl.question(`${prompt} (y/N): `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}
