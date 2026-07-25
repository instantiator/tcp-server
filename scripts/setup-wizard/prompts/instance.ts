import { promptWithHelp } from '../utils/prompt-with-help';

export interface InstanceResult {
  instanceName: string;
  envFileName: string;
}

/** Prompts for instance suffix and env file name. */
export async function promptInstance(): Promise<InstanceResult> {
  const answers = await promptWithHelp<{ instanceSuffix: string; envFileName: string }>([
    {
      type: 'input',
      name: 'instanceSuffix',
      message: 'Instance suffix (the part after "lcp-"):',
      default: 'dev',
      validate: (input: string) =>
        input.trim().length > 0 || 'Suffix cannot be empty',
      help: `The instance suffix identifies this configuration. It's used to:
  - Name the .env file (e.g., .env.dev, .env.staging)
  - Distinguish between multiple local configurations

Common suffixes: dev, staging, prod, local`,
    },
    {
      type: 'input',
      name: 'envFileName',
      message: 'Env file name:',
      default: (a: Record<string, string>) => `.env.${a.instanceSuffix}`,
      validate: (input: string) =>
        input.startsWith('.env.') || 'File name must start with .env.',
      help: `The env file stores all configuration for this instance.
  - Must start with .env.
  - Example: .env.dev, .env.staging
  - The wizard preserves values you've manually edited on re-run.`,
    },
  ]);

  return {
    instanceName: `lcp-${answers.instanceSuffix}`,
    envFileName: answers.envFileName,
  };
}
