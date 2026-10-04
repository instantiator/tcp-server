import { randomUUID } from 'node:crypto';
import type { StubResponse, StubTool } from '../config.ts';
import type {
  ApiFormat,
  ErrorKind,
  FormatError,
  FormatRoute,
  ParsedPrompt,
  StreamChunk,
} from './api-format.ts';

/** A content "part" of a multi-part message body, e.g. `{ type: 'text', text: '...' }`. */
interface ContentPart {
  text?: string;
}

interface ChatMessage {
  role: string;
  content: string | ContentPart[];
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== 'object' || value === null) return false;
  const content = (value as Record<string, unknown>).content;
  return typeof content === 'string' || Array.isArray(content);
}

/**
 * Real OpenAI clients (`@langchain/openai` included) don't always send plain
 * string message content — every role can instead be an array of content
 * parts (`[{ type: 'text', text: '...' }, ...]`), the modern multi-part
 * shape. Concatenates the text of either form.
 */
function extractText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter(
      (part): part is ContentPart & { text: string } =>
        typeof part.text === 'string',
    )
    .map((part) => part.text)
    .join('');
}

function toolCallJson(tool: StubTool) {
  return {
    id: `call_${randomUUID()}`,
    type: 'function' as const,
    function: { name: tool.tool, arguments: JSON.stringify(tool.data) },
  };
}

/** Deterministic completion-token estimate: ⌈(text + JSON of tool calls).length / 4⌉. */
function completionTokens(response: StubResponse): number {
  const toolsJson = response.tools?.length
    ? JSON.stringify(response.tools.map(toolCallJson))
    : '';
  return Math.ceil((response.text + toolsJson).length / 4);
}

/** Builds the OpenAI `usage` object for a chosen response, given its prompt-token estimate. */
function usageJson(response: StubResponse, promptTokens: number) {
  const completion = completionTokens(response);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completion,
    total_tokens: promptTokens + completion,
  };
}

function openAiError(
  status: number,
  message: string,
  code: string | null,
): FormatError {
  return {
    status,
    body: { error: { message, type: 'invalid_request_error', code } },
  };
}

/** OpenAI-compatible `/v1/chat/completions` — the only format this suite's client (`@langchain/openai`) speaks. */
export const openAiFormat: ApiFormat = {
  name: 'openai',

  routes(): FormatRoute[] {
    return [{ method: 'POST', path: '/v1/chat/completions' }];
  },

  parsePrompt(body: unknown): ParsedPrompt {
    const record =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)
        : undefined;
    const messages = record?.messages;
    const promptText = Array.isArray(messages)
      ? messages
          .filter(isChatMessage)
          .map((m) => extractText(m.content))
          .join('\n')
      : '';
    const wantsStream = record?.stream === true;
    const promptTokens = Math.ceil(
      JSON.stringify(Array.isArray(messages) ? messages : []).length / 4,
    );
    const streamOptions = record?.stream_options;
    const includeUsageInStream =
      typeof streamOptions === 'object' &&
      streamOptions !== null &&
      (streamOptions as Record<string, unknown>).include_usage === true;
    return { promptText, wantsStream, promptTokens, includeUsageInStream };
  },

  authHeaderValue(key: string) {
    return { header: 'authorization', value: `Bearer ${key}` };
  },

  buildResponse(response: StubResponse, promptTokens: number): unknown {
    return {
      id: `chatcmpl-${randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'tcp-stub-llm',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: response.text,
            tool_calls: response.tools?.length
              ? response.tools.map(toolCallJson)
              : undefined,
          },
          finish_reason: response.tools?.length ? 'tool_calls' : 'stop',
        },
      ],
      usage: usageJson(response, promptTokens),
    };
  },

  buildStreamChunks(
    response: StubResponse,
    promptTokens: number,
    includeUsageInStream: boolean,
  ): StreamChunk[] {
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const chunk = (
      delta: Record<string, unknown>,
      finishReason: string | null,
    ) =>
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: 'tcp-stub-llm',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`;

    const chunks: StreamChunk[] = [chunk({ role: 'assistant' }, null)];
    const words = response.text.length > 0 ? response.text.split(' ') : [];
    words.forEach((word, i) => {
      chunks.push(chunk({ content: i === 0 ? word : ` ${word}` }, null));
    });
    if (response.tools?.length) {
      const toolCalls = response.tools.map((tool, index) => ({
        index,
        ...toolCallJson(tool),
      }));
      chunks.push(chunk({ tool_calls: toolCalls }, null));
      chunks.push(chunk({}, 'tool_calls'));
    } else {
      chunks.push(chunk({}, 'stop'));
    }
    if (includeUsageInStream) {
      // OpenAI's documented shape for the final usage chunk: an empty
      // `choices` array alongside the `usage` object, sent just before [DONE].
      chunks.push(
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: 'tcp-stub-llm',
          choices: [],
          usage: usageJson(response, promptTokens),
        })}\n\n`,
      );
    }
    chunks.push('data: [DONE]\n\n');
    return chunks;
  },

  buildError(kind: ErrorKind): FormatError {
    switch (kind) {
      case 'auth':
        return openAiError(
          401,
          'Incorrect API key provided.',
          'invalid_api_key',
        );
      case 'no-match':
        return openAiError(
          400,
          'tcp-stub-llm: no prompt rule matched and no defaults are configured.',
          null,
        );
      case 'exhausted':
        return openAiError(
          400,
          'tcp-stub-llm: the matched response list is exhausted (mode "sequence").',
          null,
        );
    }
  },
};
