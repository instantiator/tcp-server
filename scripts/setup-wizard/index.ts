#!/usr/bin/env npx tsx
/**
 * Setup wizard for TCP Server — guides users through initial configuration
 * and generates `.env.<instance>` files with explanatory comments.
 *
 * Run via: `npm run setup` or `./scripts/setup-wizard.sh`
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import inquirer from 'inquirer';
import type { WizardConfig } from './types';
import { promptInstance } from './prompts/instance';
import { promptPorts } from './prompts/ports';
import { promptLlm } from './prompts/llm';
import { promptOidc } from './prompts/oidc';
import { promptResources } from './prompts/resources';
import { promptDocker } from './prompts/docker';
import { writeEnvFile } from './utils/env-writer';

async function main(): Promise<void> {
  console.log('TCP Server Setup Wizard');
  console.log('=======================');
  console.log();
  console.log(
    'This wizard will guide you through configuring your TCP instance.',
  );
  console.log('Answer with ? to get help about any question.');
  console.log('Press Ctrl+C at any time to cancel.');
  console.log();

  // Collect all configuration
  const instance = await promptInstance();
  const ports = await promptPorts();
  const llm = await promptLlm();
  const oidc = await promptOidc();
  const resources = await promptResources();
  const docker = await promptDocker();

  // Assemble config
  const config: WizardConfig = {
    instanceName: instance.instanceName,
    envFileName: instance.envFileName,
    ports,
    embeddingModel: llm.embeddingModel,
    inferenceModel: llm.inferenceModel,
    oidc: oidc.oidc,
    agentIterations: resources.agentIterations,
    agentConcurrency: resources.agentConcurrency,
    docker: docker.docker,
  };

  // Display summary
  console.log();
  console.log('Configuration summary:');
  console.log(`  Instance:      ${config.instanceName}`);
  console.log(`  Env file:      ${config.envFileName}`);
  console.log(
    `  Ports:         API=${config.ports.api}, DB=${config.ports.db}, MinIO=${config.ports.minio}, Zitadel=${config.ports.zitadel}`,
  );
  console.log(
    `  Embedding:     ${config.embeddingModel ? `${config.embeddingModel.provider}/${config.embeddingModel.model}` : 'not configured'}`,
  );
  console.log(
    `  Inference:     ${config.inferenceModel ? `${config.inferenceModel.provider}/${config.inferenceModel.model}` : 'not configured'}`,
  );
  console.log(
    `  OIDC:          ${config.oidc ? 'configured' : 'derived from Zitadel port'}`,
  );
  console.log(`  Iterations:    ${config.agentIterations}`);
  console.log(`  Concurrency:   ${config.agentConcurrency}`);
  console.log(
    `  Docker services: ${Object.entries(config.docker)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(', ')}`,
  );
  console.log();

  // Write env files (committed base + gitignored .local override)
  const { envFile, localFile } = writeEnvFile(config);
  console.log(`Config written to:   ${envFile}`);
  console.log(
    `Secret overrides:    ${localFile}  (gitignored — never committed)`,
  );
  console.log();
  console.log('Next steps:');
  console.log(`  1. Review ${config.envFileName}`);
  if (config.oidc) {
    console.log(
      `  2. Your OIDC client credentials are in ${config.envFileName}.local`,
    );
  } else {
    console.log(
      `  2. Start the stack — start-dev.sh bootstraps Zitadel and writes the`,
    );
    console.log(
      `     generated OIDC/test client credentials to ${config.envFileName}.local`,
    );
  }
  const startCommand = `./scripts/start-dev.sh --env ${config.envFileName} --project ${config.instanceName}`;
  console.log(`  3. Run: ${startCommand}`);
  console.log();

  const { start } = await inquirer.prompt<{ start: boolean }>({
    type: 'confirm',
    name: 'start',
    message: 'Start the stack now?',
    default: true,
  });
  if (!start) return;

  // The project name keeps each instance's containers and volumes apart.
  const result = spawnSync(
    join(__dirname, '..', 'start-dev.sh'),
    ['--env', envFile, '--project', config.instanceName],
    { stdio: 'inherit' },
  );
  process.exitCode = result.status ?? 1;
}

main().catch((err: unknown) => {
  console.error('Wizard failed:', err);
  process.exit(1);
});
