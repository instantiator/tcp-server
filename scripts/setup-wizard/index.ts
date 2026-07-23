#!/usr/bin/env npx tsx
/**
 * Setup wizard for LCP Server — guides users through initial configuration
 * and generates `.env.<instance>` files with explanatory comments.
 *
 * Run via: `npm run setup` or `./scripts/setup-wizard.sh`
 */

import type { WizardConfig } from './types';
import { promptInstance } from './prompts/instance';
import { promptLlm } from './prompts/llm';
import { promptOidc } from './prompts/oidc';
import { promptResources } from './prompts/resources';
import { promptDocker } from './prompts/docker';
import { writeEnvFile } from './utils/env-writer';

async function main(): Promise<void> {
  console.log('LCP Server Setup Wizard');
  console.log('=======================');
  console.log();
  console.log('This wizard will guide you through configuring your LCP instance.');
  console.log('Answer with ? to get help about any question.');
  console.log('Press Ctrl+C at any time to cancel.');
  console.log();

  // Collect all configuration
  const instance = await promptInstance();
  const llm = await promptLlm();
  const oidc = await promptOidc();
  const resources = await promptResources();
  const docker = await promptDocker();

  // Assemble config
  const config: WizardConfig = {
    instanceName: instance.instanceName,
    envFileName: instance.envFileName,
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
  console.log(`  Embedding:     ${config.embeddingModel ? `${config.embeddingModel.provider}/${config.embeddingModel.model}` : 'not configured'}`);
  console.log(`  Inference:     ${config.inferenceModel ? `${config.inferenceModel.provider}/${config.inferenceModel.model}` : 'not configured'}`);
  console.log(`  OIDC:          ${config.oidc ? 'configured' : 'stubbed for local dev'}`);
  console.log(`  Iterations:    ${config.agentIterations}`);
  console.log(`  Concurrency:   ${config.agentConcurrency}`);
  console.log(`  Docker services: ${Object.entries(config.docker).filter(([, v]) => v).map(([k]) => k).join(', ')}`);
  console.log();

  // Write env file
  const filePath = writeEnvFile(config);
  console.log(`Env file written to: ${filePath}`);
  console.log();
  console.log('Next steps:');
  console.log('  1. Review the generated .env file');
  console.log('  2. Run: npm run dev');
}

main().catch((err: unknown) => {
  console.error('Wizard failed:', err);
  process.exit(1);
});
