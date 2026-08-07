import inquirer from 'inquirer';
import type { DockerConfig } from '../types';

export interface DockerAnswers {
  docker: DockerConfig;
}

const DOCKER_HELP = `
Docker Compose services your local environment needs.

PostgreSQL: Primary database (required for data persistence)
Redis: Caching and session storage
MinIO: Object storage (S3-compatible) for documents and files
Zitadel: OIDC identity provider (only needed if not using external OIDC)
Stub LLM: Local mock LLM server for testing without API keys
`.trim();

const SERVICES: Array<{ name: keyof DockerConfig; label: string }> = [
  { name: 'postgres', label: 'PostgreSQL' },
  { name: 'redis', label: 'Redis' },
  { name: 'minio', label: 'MinIO (object storage)' },
  { name: 'zitadel', label: 'Zitadel (OIDC provider)' },
  { name: 'stubLlm', label: 'Stub LLM server' },
];

/** Prompts for Docker Compose service selection. */
export async function promptDocker(): Promise<DockerAnswers> {
  const { wantHelp } = await inquirer.prompt<{ wantHelp: string }>({
    type: 'input',
    name: 'wantHelp',
    message: 'Which Docker Compose services do you want to run? — need more info first? (y/n)',
    default: 'n',
    validate: (input: string) => {
      const lower = input.trim().toLowerCase();
      if (['y', 'yes', 'n', 'no', ''].includes(lower)) return true;
      return 'Please enter y or n.';
    },
  });

  if (wantHelp.trim().toLowerCase() === 'y' || wantHelp.trim().toLowerCase() === 'yes') {
    console.log(`\n${DOCKER_HELP}\n`);
  }

  const answers = await inquirer.prompt<{ selected: string[] }>([
    {
      type: 'checkbox',
      name: 'selected',
      message: 'Which Docker Compose services do you want to run?',
      choices: SERVICES.map((s) => ({ name: s.label, checked: true })),
      validate: (input: string[]) =>
        input.length > 0 || 'Select at least one service',
    },
  ]);

  const selected = new Set(answers.selected);
  const docker: DockerConfig = {
    postgres: selected.has('PostgreSQL'),
    redis: selected.has('Redis'),
    minio: selected.has('MinIO (object storage)'),
    zitadel: selected.has('Zitadel (OIDC provider)'),
    stubLlm: selected.has('Stub LLM server'),
  };

  return { docker };
}
