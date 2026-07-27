/** Response-selection strategy for a prompt rule or the default response group. */
export type ResponseMode = 'loop' | 'random' | 'sequence';

/** A tool call embedded in a canned response, matching the shape of a real MCP tool invocation. */
export interface StubTool {
  tool: string;
  data: unknown;
}

/** One canned reply: text, optionally paired with tool calls the caller should dispatch. */
export interface StubResponse {
  text: string;
  tools?: StubTool[];
}

/** A group of candidate responses plus the strategy used to pick among them. */
export interface ResponseGroup {
  responses: StubResponse[];
  mode?: ResponseMode;
}

/** Matches an inbound prompt (by regex) to a group of candidate responses. */
export interface PromptRule extends ResponseGroup {
  match: string;
}

/** The wire formats `tcp-stub-llm` knows how to speak. Only `openai` exists today. */
export type ApiFormatName = 'openai';

/** Top-level configuration: how to authenticate, how "slow" to be, and what to say. */
export interface StubLlmConfig {
  apiFormat?: ApiFormatName;
  key?: string;
  minDelay?: number;
  maxDelay?: number;
  prompts?: PromptRule[];
  defaults?: ResponseGroup;
}

/** Config with every optional field defaulted, as used internally once loaded. */
export type ResolvedStubLlmConfig = Required<
  Pick<StubLlmConfig, 'apiFormat' | 'minDelay' | 'maxDelay' | 'prompts'>
> &
  Pick<StubLlmConfig, 'key' | 'defaults'>;

const RESPONSE_MODES: ResponseMode[] = ['loop', 'random', 'sequence'];

/** Raised for a config that fails validation, naming the offending field. */
export class ConfigValidationError extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateResponse(value: unknown, path: string): StubResponse {
  if (!isPlainObject(value) || typeof value.text !== 'string') {
    throw new ConfigValidationError(
      `${path}: expected { text: string, tools?: [...] }`,
    );
  }
  let tools: StubTool[] | undefined;
  if (value.tools !== undefined) {
    if (!Array.isArray(value.tools)) {
      throw new ConfigValidationError(`${path}.tools: expected an array`);
    }
    tools = value.tools.map((t: unknown, i: number) => {
      if (!isPlainObject(t) || typeof t.tool !== 'string' || !('data' in t)) {
        throw new ConfigValidationError(
          `${path}.tools[${i}]: expected { tool: string, data: unknown }`,
        );
      }
      return { tool: t.tool, data: t.data };
    });
  }
  return { text: value.text, tools };
}

function validateMode(value: unknown, path: string): ResponseMode | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    !RESPONSE_MODES.includes(value as ResponseMode)
  ) {
    throw new ConfigValidationError(
      `${path}: expected one of ${RESPONSE_MODES.join(', ')}`,
    );
  }
  return value as ResponseMode;
}

function validateResponseGroup(value: unknown, path: string): ResponseGroup {
  if (!isPlainObject(value) || !Array.isArray(value.responses)) {
    throw new ConfigValidationError(
      `${path}: expected { responses: [...], mode?: string }`,
    );
  }
  return {
    responses: value.responses.map((r: unknown, i: number) =>
      validateResponse(r, `${path}.responses[${i}]`),
    ),
    mode: validateMode(value.mode, `${path}.mode`),
  };
}

function validatePromptRule(value: unknown, path: string): PromptRule {
  if (!isPlainObject(value) || typeof value.match !== 'string') {
    throw new ConfigValidationError(
      `${path}.match: expected a string (regex source)`,
    );
  }
  const group = validateResponseGroup(value, path);
  try {
    new RegExp(value.match);
  } catch (cause) {
    throw new ConfigValidationError(
      `${path}.match: not a valid regular expression (${String(cause)})`,
    );
  }
  return { match: value.match, ...group };
}

/**
 * Parses and validates a raw config object (already JSON-parsed). Throws
 * {@link ConfigValidationError} naming the first offending field.
 */
export function validateConfig(raw: unknown): StubLlmConfig {
  if (!isPlainObject(raw)) {
    throw new ConfigValidationError('config: expected a JSON object');
  }
  if (raw.apiFormat !== undefined && raw.apiFormat !== 'openai') {
    throw new ConfigValidationError(
      `apiFormat: only "openai" is supported today, got ${JSON.stringify(raw.apiFormat)}`,
    );
  }
  if (raw.key !== undefined && typeof raw.key !== 'string') {
    throw new ConfigValidationError('key: expected a string');
  }
  for (const field of ['minDelay', 'maxDelay'] as const) {
    const value = raw[field];
    if (value !== undefined && (typeof value !== 'number' || value < 0)) {
      throw new ConfigValidationError(
        `${field}: expected a non-negative number`,
      );
    }
  }
  const prompts =
    raw.prompts === undefined
      ? undefined
      : Array.isArray(raw.prompts)
        ? raw.prompts.map((p: unknown, i: number) =>
            validatePromptRule(p, `prompts[${i}]`),
          )
        : (() => {
            throw new ConfigValidationError('prompts: expected an array');
          })();
  const defaults =
    raw.defaults === undefined
      ? undefined
      : validateResponseGroup(raw.defaults, 'defaults');

  return {
    apiFormat: raw.apiFormat,
    key: raw.key,
    minDelay: raw.minDelay as number | undefined,
    maxDelay: raw.maxDelay as number | undefined,
    prompts,
    defaults,
  };
}

/** Fills in defaults for every optional field, for internal use once a config is accepted. */
export function resolveConfig(config: StubLlmConfig): ResolvedStubLlmConfig {
  return {
    apiFormat: config.apiFormat ?? 'openai',
    key: config.key,
    minDelay: config.minDelay ?? 0,
    maxDelay: config.maxDelay ?? 0,
    prompts: config.prompts ?? [],
    defaults: config.defaults,
  };
}

/**
 * Strips `//` line comments and `/* *\/` block comments from JSONC, leaving
 * string contents untouched, so the example config in the design doc (and
 * hand-edited config files) can carry explanatory comments without a parser
 * dependency.
 */
export function stripJsonComments(source: string): string {
  let out = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source.charAt(i);
    const next = source.charAt(i + 1);
    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next;
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
    } else if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Loads, strips comments from, parses, and validates a config file. */
export async function loadConfigFile(path: string): Promise<StubLlmConfig> {
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(raw));
  } catch (cause) {
    throw new ConfigValidationError(
      `${path}: not valid JSON/JSONC (${String(cause)})`,
    );
  }
  return validateConfig(parsed);
}

/** Returns a copy of the config with `key` masked, safe to expose over `GET /stub/config`. */
export function maskConfig(config: StubLlmConfig): StubLlmConfig {
  return { ...config, key: config.key ? '***' : undefined };
}
