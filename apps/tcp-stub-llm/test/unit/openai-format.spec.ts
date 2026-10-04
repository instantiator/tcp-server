import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openAiFormat } from '../../src/formats/openai.ts';

test('parsePrompt joins message content and reads the stream flag', () => {
  const { promptText, wantsStream } = openAiFormat.parsePrompt({
    messages: [
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'hello' },
    ],
    stream: true,
  });
  assert.equal(promptText, 'be helpful\nhello');
  assert.equal(wantsStream, true);
});

test('parsePrompt estimates prompt tokens from the JSON length of the messages', () => {
  const messages = [
    { role: 'system', content: 'be helpful' },
    { role: 'user', content: 'hello' },
  ];
  const { promptTokens } = openAiFormat.parsePrompt({ messages });
  assert.equal(promptTokens, Math.ceil(JSON.stringify(messages).length / 4));
});

test('parsePrompt reads stream_options.include_usage', () => {
  const withIt = openAiFormat.parsePrompt({
    messages: [],
    stream_options: { include_usage: true },
  });
  assert.equal(withIt.includeUsageInStream, true);

  const withoutIt = openAiFormat.parsePrompt({ messages: [] });
  assert.equal(withoutIt.includeUsageInStream, false);
});

test('parsePrompt extracts text from multi-part message content', () => {
  // Real OpenAI clients (including @langchain/openai) don't always send
  // plain string content — every role can send an array of content parts
  // instead, the modern multi-part shape.
  const { promptText } = openAiFormat.parsePrompt({
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'be helpful' }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'text', text: ' there' },
        ],
      },
    ],
  });
  assert.equal(promptText, 'be helpful\nhello there');
});

test('parsePrompt tolerates a missing/malformed body', () => {
  assert.deepEqual(openAiFormat.parsePrompt(undefined), {
    promptText: '',
    wantsStream: false,
    promptTokens: Math.ceil(JSON.stringify([]).length / 4),
    includeUsageInStream: false,
  });
  assert.deepEqual(openAiFormat.parsePrompt({}), {
    promptText: '',
    wantsStream: false,
    promptTokens: Math.ceil(JSON.stringify([]).length / 4),
    includeUsageInStream: false,
  });
});

test('authHeaderValue is a bearer token', () => {
  assert.deepEqual(openAiFormat.authHeaderValue('secret'), {
    header: 'authorization',
    value: 'Bearer secret',
  });
});

test('buildResponse omits tool_calls and uses finish_reason "stop" for a plain reply', () => {
  const body = openAiFormat.buildResponse({ text: 'hi there' }, 10) as {
    choices: {
      message: { content: string; tool_calls?: unknown };
      finish_reason: string;
    }[];
  };
  assert.equal(body.choices[0]?.message.content, 'hi there');
  assert.equal(body.choices[0]?.message.tool_calls, undefined);
  assert.equal(body.choices[0]?.finish_reason, 'stop');
});

test('buildResponse maps tools to OpenAI-shaped tool_calls and finish_reason "tool_calls"', () => {
  const body = openAiFormat.buildResponse(
    {
      text: 'calling a tool',
      tools: [
        {
          tool: 'tcp-mcp-tasks__complete_assignment',
          data: { summary: 'done' },
        },
      ],
    },
    10,
  ) as {
    choices: {
      message: {
        tool_calls?: {
          type: string;
          function: { name: string; arguments: string };
        }[];
      };
      finish_reason: string;
    }[];
  };
  const toolCalls = body.choices[0]?.message.tool_calls;
  assert.equal(toolCalls?.length, 1);
  assert.equal(toolCalls?.[0]?.type, 'function');
  assert.equal(
    toolCalls?.[0]?.function.name,
    'tcp-mcp-tasks__complete_assignment',
  );
  assert.deepEqual(JSON.parse(toolCalls?.[0]?.function.arguments ?? '{}'), {
    summary: 'done',
  });
  assert.equal(body.choices[0]?.finish_reason, 'tool_calls');
});

test('buildResponse reports non-zero, deterministic usage derived from prompt and completion length', () => {
  const body = openAiFormat.buildResponse({ text: 'hi there' }, 10) as {
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  };
  assert.equal(body.usage.prompt_tokens, 10);
  assert.equal(body.usage.completion_tokens, Math.ceil('hi there'.length / 4));
  assert.equal(
    body.usage.total_tokens,
    body.usage.prompt_tokens + body.usage.completion_tokens,
  );
});

test('buildStreamChunks streams role, word deltas, finish, and [DONE]', () => {
  const chunks = openAiFormat.buildStreamChunks(
    { text: 'hi there' },
    10,
    false,
  );
  assert.equal(chunks.at(-1), 'data: [DONE]\n\n');
  assert.match(chunks[0] ?? '', /"role":"assistant"/);
  const joined = chunks.join('');
  assert.match(joined, /"content":"hi"/);
  assert.match(joined, /"content":" there"/);
  assert.match(joined, /"finish_reason":"stop"/);
});

test('buildStreamChunks carries tool_calls and finishes with "tool_calls"', () => {
  const chunks = openAiFormat.buildStreamChunks(
    {
      text: '',
      tools: [{ tool: 'x__y', data: { a: 1 } }],
    },
    10,
    false,
  );
  const joined = chunks.join('');
  assert.match(joined, /"tool_calls"/);
  assert.match(joined, /"finish_reason":"tool_calls"/);
});

test('buildStreamChunks omits a usage chunk when include_usage was not requested', () => {
  const chunks = openAiFormat.buildStreamChunks(
    { text: 'hi there' },
    10,
    false,
  );
  assert.ok(!chunks.some((c) => c.includes('"usage"')));
});

test('buildStreamChunks emits one final usage-only chunk before [DONE] when include_usage was requested', () => {
  const chunks = openAiFormat.buildStreamChunks({ text: 'hi there' }, 10, true);
  assert.equal(chunks.at(-1), 'data: [DONE]\n\n');
  const usageLine = chunks.at(-2) ?? '';
  const parsed = JSON.parse(usageLine.replace(/^data: /, '').trim()) as {
    choices: unknown[];
    usage: { prompt_tokens: number; total_tokens: number };
  };
  assert.deepEqual(parsed.choices, []);
  assert.equal(parsed.usage.prompt_tokens, 10);
  assert.ok(parsed.usage.total_tokens > parsed.usage.prompt_tokens);
});

test('buildError returns the right status for each failure kind', () => {
  assert.equal(openAiFormat.buildError('auth').status, 401);
  assert.equal(openAiFormat.buildError('no-match').status, 400);
  assert.equal(openAiFormat.buildError('exhausted').status, 400);
});
