/**
 * Substrings seen across LLM providers (OpenAI-compatible APIs, LM Studio,
 * Anthropic) when a request's token count exceeds the model's context
 * window. Used as a reactive backstop for cases the proactive
 * tiktoken-based budget check underestimates (bound-tools schema overhead,
 * provider-specific tokenizer differences).
 */
const CONTEXT_LENGTH_ERROR_SUBSTRINGS = [
  'context_length_exceeded',
  'maximum context length',
  'context size has been exceeded',
  'context window',
  'too many tokens',
  'prompt is too long',
];

/**
 * Returns `true` when `err` looks like a provider-reported context-length
 * exceeded error, based on matching known substrings in its message
 * (case-insensitive).
 */
export function isContextLengthError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  return CONTEXT_LENGTH_ERROR_SUBSTRINGS.some((s) => lower.includes(s));
}
