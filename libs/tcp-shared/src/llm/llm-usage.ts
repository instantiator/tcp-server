/**
 * One LLM call's token usage; field names map 1:1 to OpenTelemetry GenAI
 * `gen_ai.usage.*` (still "Development" status — no OTel dependency is taken
 * on here, the field names just stay compatible with it).
 */
export interface LlmUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** The provider/model identity a usage figure is attributed to. */
export interface LlmIdentity {
  provider: string;
  model: string;
}

/** Reads a nested field of an unknown object without a type escape. */
function field(obj: unknown, key: string): unknown {
  return obj && typeof obj === 'object'
    ? (obj as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Reads LangChain's `usage_metadata` (`input_tokens`/`output_tokens`) off an
 * AIMessage-like value — the shape both a `streamEvents` `on_chat_model_end`
 * output and a direct `model.invoke()` result share. Returns `undefined` when
 * `usage_metadata` is absent or neither count is a number, which is how a
 * provider that doesn't report usage looks.
 */
export function usageFromMessage(
  message: unknown,
  llm: LlmIdentity,
): LlmUsage | undefined {
  const usage = field(message, 'usage_metadata');
  const inputTokens = field(usage, 'input_tokens');
  const outputTokens = field(usage, 'output_tokens');
  if (typeof inputTokens !== 'number' && typeof outputTokens !== 'number') {
    return undefined;
  }
  return {
    provider: llm.provider,
    model: llm.model,
    inputTokens: typeof inputTokens === 'number' ? inputTokens : 0,
    outputTokens: typeof outputTokens === 'number' ? outputTokens : 0,
  };
}

/** Runtime shape check for an unknown value read back off an audit payload. */
export function isLlmUsage(value: unknown): value is LlmUsage {
  return (
    typeof field(value, 'provider') === 'string' &&
    typeof field(value, 'model') === 'string' &&
    typeof field(value, 'inputTokens') === 'number' &&
    typeof field(value, 'outputTokens') === 'number'
  );
}
