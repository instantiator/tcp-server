#!/usr/bin/env npx tsx
/**
 * Setup wizard for TCP Server — guides users through initial configuration
 * and generates `.env.<instance>` files with explanatory comments.
 *
 * Run via: `npm run setup` or `./scripts/setup-wizard.sh`
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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
import { describeWizardError } from './utils/describe-wizard-error';
import { testConfig } from './test-config';

/** The env file, once written — so a cancelled run can say it was kept. */
let writtenTo: string | undefined;

/**
 * `--test-config [--env <file>] [--project <name>]`: check an existing
 * configuration's connections instead of running the wizard. The defaults
 * match start-dev.sh's.
 */
async function runTestConfig(args: readonly string[]): Promise<number> {
  const valueOf = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  const repoRoot = join(__dirname, '..', '..');
  const envFile =
    valueOf('--env') ??
    (existsSync(join(repoRoot, '.env.dev')) ? '.env.dev' : '.env.testing');
  return testConfig({ envFile, project: valueOf('--project') ?? 'tcp-dev' });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--test-config')) {
    process.exitCode = await runTestConfig(args);
    return;
  }

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
  const docker = await promptDocker(
    llm.inferenceModel !== undefined,
    oidc.oidc !== undefined,
  );

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
    stubLlm: docker.stubLlm,
  };

  // Display summary
  console.log();
  console.log('Configuration summary:');
  console.log(`  Instance:      ${config.instanceName}`);
  console.log(`  Env file:      ${config.envFileName}`);
  console.log(
    `  Ports:         API=${config.ports.api}, DB=${config.ports.db}, MinIO=${config.ports.minio}/${config.ports.minioConsole}, web=${config.ports.web}, agent=${config.ports.agent}`,
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
  console.log(`  Stub LLM:      ${config.stubLlm ? 'yes' : 'no'}`);
  console.log();

  // Write env files (committed base + gitignored .local override)
  const { envFile, localFile } = writeEnvFile(config);
  writtenTo = envFile;
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
  const startScript = join(__dirname, '..', 'start-dev.sh');
  const result = spawnSync(
    startScript,
    ['--env', envFile, '--project', config.instanceName],
    { stdio: 'inherit' },
  );
  if (result.error) {
    console.error(
      `\nCouldn't run ${startScript}: ${result.error.message}. Check the file exists and is executable (chmod +x).`,
    );
    process.exitCode = 1;
    return;
  }
  if (result.status !== 0) {
    console.error(
      `\nThe stack didn't start. The error above says which step failed.\nFix it and re-run: ${startCommand}\nYour configuration is saved in ${config.envFileName}.`,
    );
    process.exitCode = result.status ?? 1;
    return;
  }

  const { test } = await inquirer.prompt<{ test: boolean }>({
    type: 'confirm',
    name: 'test',
    message: 'Test the configuration now?',
    default: true,
  });
  if (test) {
    console.log();
    process.exitCode = await testConfig({
      envFile: config.envFileName,
      project: config.instanceName,
    });
  }
}

main().catch((err: unknown) => {
  const { message, exitCode } = describeWizardError(err, writtenTo);
  console.error(`\n${message}`);
  if (process.env['DEBUG']) console.error(err);
  process.exit(exitCode);
});
