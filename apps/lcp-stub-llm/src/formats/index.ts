import type { ApiFormatName } from '../config.ts';
import type { ApiFormat } from './api-format.ts';
import { openAiFormat } from './openai.ts';

/**
 * Registered wire-format adapters. Adding a new provider (Anthropic Messages,
 * Ollama, Gemini, ...) means writing one `formats/<name>.ts` implementing
 * {@link ApiFormat} and registering it here — nothing else in the app changes.
 */
const FORMATS: Record<ApiFormatName, ApiFormat> = {
  openai: openAiFormat,
};

export function getFormat(name: ApiFormatName): ApiFormat {
  return FORMATS[name];
}
