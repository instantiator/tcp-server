import inquirer from 'inquirer';
import {
  PROVIDER_CATALOGUE,
  fillBaseUrl,
  MAX_EMBEDDING_DIMENSION,
  type ProviderField,
  type ProviderTemplate,
} from '@tcp/shared/llm/provider-catalogue';
import type { LlmProviderConfig } from '../types';
import { promptWithHelp } from '../utils/prompt-with-help';
import { validateModel } from '../utils/model-validator';
import { lookupContextWindow } from '../utils/context-lookup';
import { isHostLocal, toDockerHost } from '../utils/docker-host';
import { DEFAULT_EMBEDDING_DIMENSION } from '../utils/app-defaults';

/** What each purpose is asked for and called, in prompts. */
type Purpose = 'chat' | 'embedding';

export interface LlmAnswers {
  configureEmbedding: boolean;
  embeddingModel?: LlmProviderConfig;
  configureInference: boolean;
  inferenceModel?: LlmProviderConfig;
}

/**
 * Walks the user through the application-level chat model, then the
 * embedding model — each a provider choice, connection details, a
 * connectivity test, and a context window or vector width.
 */
export async function promptLlm(): Promise<LlmAnswers> {
  const inferenceModel = await promptProvider('chat');
  const embeddingModel = await promptProvider('embedding', inferenceModel);

  return {
    configureInference: inferenceModel !== undefined,
    inferenceModel,
    configureEmbedding: embeddingModel !== undefined,
    embeddingModel,
  };
}

/** Everything collected before the connectivity test: provider, fields, model, URL. */
interface DraftConnection {
  template: ProviderTemplate;
  apiKey: string;
  region?: string;
  resource?: string;
  model: string;
  /** The URL to test from — always reachable from where the wizard runs. */
  probeUrl: string;
  /** The URL to write to the env file — converted for Docker, when local. */
  writeUrl: string;
  /** `true` when the user chose to skip the connectivity test entirely. */
  skipTest: boolean;
}

/**
 * Runs the whole flow for one purpose: intro, provider choice, connection
 * details, a connectivity test, and the context window or vector width.
 * Returns `undefined` when the user declines to configure it.
 */
async function promptProvider(
  purpose: Purpose,
  chatModel?: LlmProviderConfig,
): Promise<LlmProviderConfig | undefined> {
  console.log();
  console.log(introText(purpose));

  const { configure } = await promptWithHelp<{ configure: boolean }>([
    {
      type: 'confirm',
      name: 'configure',
      message: `Configure a default ${purposeLabel(purpose)} model?`,
      default: true,
    },
  ]);

  if (!configure) {
    if (purpose === 'embedding') printSkippedEmbeddingNotice();
    return undefined;
  }

  for (;;) {
    const draft = await collectDraft(purpose, chatModel);

    let outcome: ConnectionOutcome | undefined;
    if (!draft.skipTest) {
      outcome = await testConnection(
        {
          provider: draft.template.id,
          model: draft.model,
          baseUrl: draft.probeUrl,
          apiKey: draft.apiKey,
        },
        purpose,
      );
      if (outcome.status === 'change') continue;
    }

    // `undefined` means the settings can never work (an embedding too wide to
    // index), so the provider choice starts again.
    const config = await finish(
      draft,
      purpose,
      outcome?.status === 'ok' ? outcome : undefined,
    );
    if (config) return config;
  }
}

function introText(purpose: Purpose): string {
  return purpose === 'chat'
    ? 'This will be the default model for every company you set up. A company, or a role within it, can override it later.'
    : 'This will be the default model for every company you set up. A company can override it.';
}

function purposeLabel(purpose: Purpose): string {
  return purpose === 'chat' ? 'inference (chat)' : 'embedding';
}

function printSkippedEmbeddingNotice(): void {
  console.log(
    "\nWithout an embedding model, you won't be able to upload knowledge documents for roles.",
  );
  console.log('You can set one later in your env file, or per company.\n');
}

/** Collects the provider, its fields, the model name, and the base URL. */
async function collectDraft(
  purpose: Purpose,
  chatModel: LlmProviderConfig | undefined,
): Promise<DraftConnection> {
  const template = await chooseProvider(purpose, chatModel);
  if (template.notes) console.log(`\n${template.notes}\n`);

  const fields = await askFields(template, purpose, chatModel);

  let skipTest = false;
  if (template.kind === 'local') {
    skipTest = await confirmLocalReady(template, purpose);
  }

  const model = await askModel(template, purpose);
  const { probeUrl, writeUrl } = await resolveBaseUrl(template, fields);

  return {
    template,
    apiKey: fields.apiKey,
    region: fields.region,
    resource: fields.resource,
    model,
    probeUrl,
    writeUrl,
    skipTest,
  };
}

/** Builds the final config once a draft has been tested (or the test skipped). */
function finish(
  draft: DraftConnection,
  purpose: Purpose,
  outcome: { dimension?: number } | undefined,
): Promise<LlmProviderConfig | undefined> {
  const config: LlmProviderConfig = {
    provider: draft.template.id,
    model: draft.model,
    baseUrl: draft.writeUrl,
    apiKey: draft.apiKey,
  };

  return purpose === 'chat'
    ? finishChat(config, draft)
    : finishEmbedding(config, draft, outcome?.dimension);
}

async function finishChat(
  config: LlmProviderConfig,
  draft: DraftConnection,
): Promise<LlmProviderConfig> {
  const contextWindow = await askContextWindow(
    draft.template,
    draft.model,
    draft.probeUrl,
  );
  return { ...config, contextWindow };
}

/**
 * Attaches the embedding dimension: from the probe when it succeeded and is
 * within the ivfflat limit, from the catalogue's starter dimension when the
 * probe was skipped and the model matches the starter, or asked otherwise.
 * Returns `undefined` for a probed dimension over the limit — there's no
 * point keeping a model that can never be indexed.
 */
async function finishEmbedding(
  config: LlmProviderConfig,
  draft: DraftConnection,
  probedDimension: number | undefined,
): Promise<LlmProviderConfig | undefined> {
  if (probedDimension !== undefined) {
    if (probedDimension > MAX_EMBEDDING_DIMENSION) {
      console.log(
        `\n${draft.model} produces ${probedDimension}-dimension vectors. TCP indexes ` +
          `embeddings with pgvector's ivfflat, which can't index more than ` +
          `${MAX_EMBEDDING_DIMENSION} dimensions. Choose a model at or below that width.\n`,
      );
      return undefined;
    }
    return { ...config, dimension: probedDimension };
  }

  const starter = draft.template.embeddings?.starterModel;
  if (starter && draft.model === starter && draft.template.embeddings) {
    return { ...config, dimension: draft.template.embeddings.dimension };
  }

  const dimension = await askDimensionNumber();
  return { ...config, dimension };
}

/** Chooses a provider, grouped Remote / Local / "Other OpenAI-compatible server". */
async function chooseProvider(
  purpose: Purpose,
  chatModel: LlmProviderConfig | undefined,
): Promise<ProviderTemplate> {
  if (purpose === 'embedding') printEmbeddingGapNotice();

  const candidates = PROVIDER_CATALOGUE.filter(
    (t) => purpose === 'chat' || t.kind === 'custom' || t.embeddings,
  );
  const defaultId =
    purpose === 'embedding' &&
    chatModel &&
    candidates.some((t) => t.id === chatModel.provider)
      ? chatModel.provider
      : undefined;

  const choices: Array<InstanceType<typeof inquirer.Separator> | Choice> = [];
  for (const kind of ['remote', 'local', 'custom'] as const) {
    const group = candidates.filter((t) => t.kind === kind);
    if (group.length === 0) continue;
    choices.push(new inquirer.Separator(groupLabel(kind, group)));
    for (const template of group) {
      choices.push({ name: template.name, value: template.id });
    }
  }

  const { value } = await inquirer.prompt<{ value: string }>({
    type: 'select',
    name: 'value',
    message: `Choose a ${purposeLabel(purpose)} provider:`,
    choices,
    default: defaultId,
  });

  // `value` always comes from a `choices` entry above, all drawn from `candidates`.
  return candidates.find((t) => t.id === value) as ProviderTemplate;
}

/**
 * The separator text for a provider group. The custom group has exactly one
 * entry, "Other OpenAI-compatible server" — its own catalogue name reads
 * fine as a header, so it's used directly rather than hard-coding it here.
 */
function groupLabel(
  kind: ProviderTemplate['kind'],
  group: readonly ProviderTemplate[],
): string {
  if (kind === 'remote') return 'Remote';
  if (kind === 'local') return 'Local';
  return group.length === 1 ? group[0].name : 'Other';
}

/** Names the providers left out of the embedding list, so their absence isn't a surprise. */
function printEmbeddingGapNotice(): void {
  const missing = PROVIDER_CATALOGUE.filter(
    (t) => t.kind !== 'custom' && !t.embeddings,
  ).map((t) => t.name);
  if (missing.length > 0) {
    console.log(
      `(Not listed: ${missing.join(', ')} — no embedding model TCP can use.)\n`,
    );
  }
}

interface Choice {
  name: string;
  value: string;
}

interface FieldAnswers {
  apiKey: string;
  region?: string;
  resource?: string;
}

/** Asks only the fields the template declares, in order. */
async function askFields(
  template: ProviderTemplate,
  purpose: Purpose,
  chatModel: LlmProviderConfig | undefined,
): Promise<FieldAnswers> {
  const answers: FieldAnswers = { apiKey: '' };

  for (const field of template.fields) {
    if (field === 'apiKey') {
      answers.apiKey = await askApiKey(template, purpose, chatModel);
    } else {
      answers[field] = await askRegionOrResource(field);
    }
  }

  return answers;
}

async function askRegionOrResource(
  field: Exclude<ProviderField, 'apiKey'>,
): Promise<string> {
  const { value } = await promptWithHelp<{ value: string }>([
    {
      type: 'input',
      name: 'value',
      message: field === 'region' ? 'AWS region:' : 'Azure resource name:',
      validate: (input: string) => input.trim().length > 0 || 'Required.',
    },
  ]);
  return value;
}

async function askApiKey(
  template: ProviderTemplate,
  purpose: Purpose,
  chatModel: LlmProviderConfig | undefined,
): Promise<string> {
  if (purpose === 'embedding' && chatModel?.provider === template.id) {
    const { same } = await promptWithHelp<{ same: boolean }>([
      {
        type: 'confirm',
        name: 'same',
        message: 'Use the same API key?',
        default: true,
      },
    ]);
    if (same) return chatModel.apiKey;
  }

  if (template.keysPageUrl) {
    console.log(`Get a key: ${template.keysPageUrl}`);
  }

  const required = template.kind !== 'local';
  const { value } = await inquirer.prompt<{ value: string }>({
    type: 'password',
    name: 'value',
    message: `${template.name} API key:`,
    mask: '*',
    validate: (input: string) =>
      !required || input.trim().length > 0 || 'API key cannot be empty.',
  });
  return value;
}

/** Asks for the model name, defaulting to the catalogue's starter model. */
async function askModel(
  template: ProviderTemplate,
  purpose: Purpose,
): Promise<string> {
  const starter =
    purpose === 'chat'
      ? template.chat?.starterModel
      : template.embeddings?.starterModel;

  const { value } = await promptWithHelp<{ value: string }>([
    {
      type: 'input',
      name: 'value',
      message: `${template.name} ${purpose === 'chat' ? 'chat' : 'embedding'} model:`,
      default: starter,
      validate: (input: string) => input.trim().length > 0 || 'Required.',
    },
  ]);
  return value;
}

/**
 * Asks "Is it running?" for a local provider. On "no", prints the install
 * instructions and the starter model, then waits for Enter (or 'skip').
 * Returns whether the user chose to skip the connectivity test.
 */
async function confirmLocalReady(
  template: ProviderTemplate,
  purpose: Purpose,
): Promise<boolean> {
  const { running } = await promptWithHelp<{ running: boolean }>([
    {
      type: 'confirm',
      name: 'running',
      message: `Is ${template.name} installed, running, and serving a model?`,
      default: true,
    },
  ]);
  if (running) return false;

  if (template.localSetup) {
    console.log(`\nInstall: ${template.localSetup.install}`);
    template.localSetup.steps.forEach((step, i) => {
      console.log(`  ${i + 1}. ${step}`);
    });
  }
  const starter =
    purpose === 'chat'
      ? template.chat?.starterModel
      : template.embeddings?.starterModel;
  if (starter) console.log(`  Starter model: ${starter}`);

  const { value } = await promptWithHelp<{ value: string }>([
    {
      type: 'input',
      name: 'value',
      message:
        "Press Enter when it's running (or type 'skip' to continue without testing it):",
      default: '',
    },
  ]);
  return value.trim().toLowerCase() === 'skip';
}

interface ResolvedUrl {
  probeUrl: string;
  writeUrl: string;
}

/**
 * Computes the base URL: filled in for a remote provider, or asked (with the
 * localhost-to-Docker conversion offered) for a local or custom one.
 */
async function resolveBaseUrl(
  template: ProviderTemplate,
  fields: FieldAnswers,
): Promise<ResolvedUrl> {
  const baseUrl =
    template.kind === 'remote'
      ? fillBaseUrl(template, fields)
      : await askEditableBaseUrl(template);

  if (!isHostLocal(baseUrl)) {
    return { probeUrl: baseUrl, writeUrl: baseUrl };
  }

  const converted = toDockerHost(baseUrl);
  console.log(
    "\nTCP's agents run inside Docker, where `localhost` means the container " +
      'itself. `host.docker.internal` reaches your machine instead.\n',
  );
  const { useConverted } = await promptWithHelp<{ useConverted: boolean }>([
    {
      type: 'confirm',
      name: 'useConverted',
      message: `Use \`${converted}\`?`,
      default: true,
    },
  ]);

  return useConverted
    ? { probeUrl: baseUrl, writeUrl: converted }
    : { probeUrl: baseUrl, writeUrl: baseUrl };
}

async function askEditableBaseUrl(template: ProviderTemplate): Promise<string> {
  const isCustom = template.kind === 'custom';
  const { value } = await promptWithHelp<{ value: string }>([
    {
      type: 'input',
      name: 'value',
      message: `${template.name} base URL:`,
      default: isCustom ? undefined : template.baseUrl,
      validate: (input: string) => input.trim().length > 0 || 'Required.',
    },
  ]);
  return value;
}

type ConnectionOutcome =
  | { status: 'ok'; dimension?: number }
  | { status: 'kept' }
  | { status: 'change' };

/**
 * Runs the connectivity test, offering "Try again / Change settings / Keep
 * these settings anyway" on failure. "Try again" repeats the same test;
 * "Change settings" bubbles up to restart the provider choice.
 */
async function testConnection(
  config: LlmProviderConfig,
  purpose: Purpose,
): Promise<ConnectionOutcome> {
  for (;;) {
    const result = await validateModel(config, purpose);
    if (result.success) {
      return { status: 'ok', dimension: result.dimension };
    }

    console.log(`\nConnection test failed: ${result.error}\n`);
    const { value } = await inquirer.prompt<{
      value: 'retry' | 'change' | 'keep';
    }>({
      type: 'select',
      name: 'value',
      message: 'What next?',
      choices: [
        { name: 'Try again', value: 'retry' },
        { name: 'Change settings', value: 'change' },
        { name: 'Keep these settings anyway', value: 'keep' },
      ],
    });

    if (value === 'retry') continue;
    return { status: value === 'change' ? 'change' : 'kept' };
  }
}

/**
 * Looks up the model's context window and offers it as a default; falls
 * back to asking for a number when the lookup fails or the user declines it.
 */
async function askContextWindow(
  template: ProviderTemplate,
  model: string,
  probeUrl: string,
): Promise<number> {
  const found = await lookupContextWindow(template, model, probeUrl);
  if (found) {
    const { useFound } = await promptWithHelp<{ useFound: boolean }>([
      {
        type: 'confirm',
        name: 'useFound',
        message: `Context window: ${found.tokens} tokens (from ${found.source}). Use this?`,
        default: true,
      },
    ]);
    if (useFound) return found.tokens;
  }

  const { value } = await promptWithHelp<{ value: number }>([
    {
      type: 'number',
      name: 'value',
      message: 'Context window size (tokens):',
      default: found?.tokens ?? 128000,
      validate: (input: number) =>
        (Number.isInteger(input) && input > 0) || 'Must be a positive integer',
      help: `The maximum number of tokens the model can process in a single request.
  - Check your model's documentation for the limit
  - Common values: 4096, 8192, 32000, 128000
  - Larger windows allow more context but cost more`,
    },
  ]);
  return value;
}

async function askDimensionNumber(): Promise<number> {
  const { value } = await promptWithHelp<{ value: number }>([
    {
      type: 'number',
      name: 'value',
      message: 'Embedding vector dimension:',
      default: DEFAULT_EMBEDDING_DIMENSION,
      validate: (input: number) =>
        (Number.isInteger(input) &&
          input > 0 &&
          input <= MAX_EMBEDDING_DIMENSION) ||
        `Must be a positive integer, at most ${MAX_EMBEDDING_DIMENSION} (pgvector's ivfflat limit).`,
      help: `The vector width of the embedding output.
  - Must match the dimension used in your existing database
  - Common values: 384, 768, 1024, 1536
  - Check your model's documentation for the correct value`,
    },
  ]);
  return value;
}
