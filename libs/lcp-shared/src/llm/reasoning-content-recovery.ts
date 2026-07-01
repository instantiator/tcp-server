import { AIMessage, BaseMessage, HumanMessage } from '@langchain/core/messages';
import { Logger } from '@nestjs/common';

/** Marker some "thinking" models (observed: Qwen3.5) use to narrate a tool call in text instead of actually invoking it. */
const NARRATED_TOOL_CALL_PATTERN = /<tool_call>/i;

const NUDGE_TOOL_CALL_NOT_INVOKED =
  "You described a tool call in your reasoning but didn't actually invoke it. If you still need to use a tool, call it now using the tool-calling mechanism — don't describe it in text.";

const NUDGE_NO_RESPONSE =
  "You haven't provided a response yet. Continue: call a tool if more work is needed, or give your final response now.";

/**
 * Prefixes emitted by terminal MCP tool results that signal the agent has
 * intentionally stopped its current turn — no further action is needed and an
 * empty response is the correct outcome. Nudging in these cases would produce
 * a spurious placeholder message the caller never asked for.
 */
const TERMINAL_TOOL_RESULT_PREFIXES = ['Paused.', 'Task marked complete.'];

/**
 * Detects and corrects two related failure modes in "thinking" models
 * (observed with Qwen3.5, and known to affect other reasoning models —
 * DeepSeek-R1, QwQ, etc. — served through OpenAI-compatible local endpoints
 * like LM Studio) that stop a turn before actually finishing it:
 *
 * - it narrates a tool call (`<tool_call>...`) inside `reasoning_content`
 *   but never actually invokes it — `tool_calls` comes back empty
 * - it leaves `content` blank with no narrated tool call at all — it
 *   simply stopped mid-thought before producing a real answer
 *
 * In both cases the response isn't trustworthy as a final result, so this
 * re-invokes the model once with a corrective nudge and uses that response
 * instead of the original. If the model still produces nothing usable after
 * the retry, `reasoning_content` is promoted into `content` as a last-resort
 * fallback so the loop doesn't return a wholly empty message.
 *
 * Detection is signal-based rather than an allowlist of model names — see
 * `docs/lcp-agent-special-cases.md` for the reasoning behind that choice.
 */
export class ReasoningContentRecovery {
  static async recover(
    messages: BaseMessage[],
    response: AIMessage,
    invoke: (messages: BaseMessage[]) => Promise<AIMessage>,
    logger?: Logger,
  ): Promise<AIMessage> {
    if (this.isUsable(response)) return response;
    if (this.lastToolWasTerminal(messages)) return response;

    const reasoning = this.reasoningContentOf(response);
    const nudgeText =
      reasoning && NARRATED_TOOL_CALL_PATTERN.test(reasoning)
        ? NUDGE_TOOL_CALL_NOT_INVOKED
        : NUDGE_NO_RESPONSE;
    logger?.warn(
      `Model "${this.modelNameOf(response)}" stopped without a usable response — nudging it to continue ("${nudgeText}").`,
    );

    const retried = await invoke([
      ...messages,
      response,
      new HumanMessage(nudgeText),
    ]);
    if (this.isUsable(retried)) return retried;

    return this.fallbackToReasoning(retried, logger) ?? retried;
  }

  /**
   * Returns true when the most recent tool result in the message history is a
   * terminal one (pause or task completion). The LLM correctly produces an
   * empty response after these — nudging would only generate a spurious
   * placeholder that the caller never asked for.
   */
  private static lastToolWasTerminal(messages: BaseMessage[]): boolean {
    const last = [...messages].reverse().find((m) => m.type === 'tool');
    const c = typeof last?.content === 'string' ? last.content : '';
    return TERMINAL_TOOL_RESULT_PREFIXES.some((p) => c.startsWith(p));
  }

  /** A response is usable if it has real content or it actually invoked a tool. */
  private static isUsable(message: AIMessage): boolean {
    const hasContent =
      typeof message.content === 'string' && message.content.trim().length > 0;
    const hasToolCalls = (message.tool_calls?.length ?? 0) > 0;
    return hasContent || hasToolCalls;
  }

  private static reasoningContentOf(message: AIMessage): string | null {
    const reasoning: unknown = message.additional_kwargs?.reasoning_content;
    return typeof reasoning === 'string' && reasoning.trim() ? reasoning : null;
  }

  private static modelNameOf(message: AIMessage): string {
    const model: unknown = message.response_metadata?.model_name;
    return typeof model === 'string' ? model : 'unknown model';
  }

  /** Last-resort fallback: promotes reasoning_content into content, if any. */
  private static fallbackToReasoning(
    message: AIMessage,
    logger?: Logger,
  ): AIMessage | null {
    const reasoning = this.reasoningContentOf(message);
    if (!reasoning) return null;

    logger?.warn(
      `Model "${this.modelNameOf(message)}" still produced no usable response after a nudge — falling back to reasoning_content.`,
    );
    message.content = reasoning.trim();
    return message;
  }
}
