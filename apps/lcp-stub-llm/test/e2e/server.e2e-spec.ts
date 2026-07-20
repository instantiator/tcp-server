import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { createStubLlmServer } from '../../src/server.ts';

describe('lcp-stub-llm server (e2e)', () => {
  let baseUrl: string;
  let close: () => Promise<void>;

  before(async () => {
    const server = createStubLlmServer({});
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    close = () =>
      new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
  });

  after(() => close());

  async function putConfig(config: unknown): Promise<void> {
    const res = await fetch(`${baseUrl}/stub/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    assert.equal(res.status, 200);
  }

  test('GET /health reports ok', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
  });

  test('a matched prompt rule returns its configured response', async () => {
    await putConfig({
      prompts: [
        {
          match: 'capital of France',
          responses: [{ text: 'Paris', tools: [] }],
        },
      ],
    });
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'what is the capital of France?' }],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      choices: { message: { content: string } }[];
    };
    assert.equal(body.choices[0]?.message.content, 'Paris');
  });

  test('an unmatched prompt falls back to defaults', async () => {
    await putConfig({
      prompts: [{ match: 'never matches this', responses: [{ text: 'x' }] }],
      defaults: { mode: 'loop', responses: [{ text: 'default reply' }] },
    });
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'anything else' }],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      choices: { message: { content: string } }[];
    };
    assert.equal(body.choices[0]?.message.content, 'default reply');
  });

  test('no matching rule and no defaults is a 400', async () => {
    await putConfig({
      prompts: [{ match: 'never matches this', responses: [{ text: 'x' }] }],
    });
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'anything else' }],
      }),
    });
    assert.equal(res.status, 400);
  });

  test('sequence mode errors once its response list is exhausted', async () => {
    await putConfig({
      defaults: { mode: 'sequence', responses: [{ text: 'only-one' }] },
    });
    const first = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
    });
    assert.equal(first.status, 200);
    const second = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
    });
    assert.equal(second.status, 400);
  });

  test('a response with tools becomes OpenAI-shaped tool_calls', async () => {
    await putConfig({
      defaults: {
        responses: [
          {
            text: 'ok',
            tools: [
              {
                tool: 'lcp-mcp-tasks__complete_assignment',
                data: { summary: 'done' },
              },
            ],
          },
        ],
      },
    });
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
    });
    const body = (await res.json()) as {
      choices: {
        message: {
          tool_calls?: { function: { name: string; arguments: string } }[];
        };
        finish_reason: string;
      }[];
    };
    const toolCall = body.choices[0]?.message.tool_calls?.[0];
    assert.equal(toolCall?.function.name, 'lcp-mcp-tasks__complete_assignment');
    assert.deepEqual(JSON.parse(toolCall?.function.arguments ?? '{}'), {
      summary: 'done',
    });
    assert.equal(body.choices[0]?.finish_reason, 'tool_calls');
  });

  test('a streaming request gets an SSE reply ending in [DONE]', async () => {
    await putConfig({
      defaults: { mode: 'loop', responses: [{ text: 'hi there' }] },
    });
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stream: true,
        messages: [{ role: 'user', content: 'x' }],
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const text = await res.text();
    assert.match(text, /"content":"hi"/);
    assert.match(text, /"content":" there"/);
    assert.ok(text.trimEnd().endsWith('data: [DONE]'));
  });

  test('POST /v1/embeddings returns a deterministic unit-norm vector per input', async () => {
    const res = await fetch(`${baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: ['hello', 'hello'] }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: { embedding: number[] }[] };
    assert.equal(body.data.length, 2);
    assert.deepEqual(body.data[0]?.embedding, body.data[1]?.embedding);
  });

  test('GET /stub/config masks a configured key', async () => {
    await putConfig({
      key: 'super-secret',
      defaults: { responses: [{ text: 'x' }] },
    });
    const res = await fetch(`${baseUrl}/stub/config`);
    const body = (await res.json()) as { key?: string };
    assert.equal(body.key, '***');
  });

  test('a configured key is required and enforced as a bearer token', async () => {
    await putConfig({
      key: 'super-secret',
      defaults: { responses: [{ text: 'ok' }] },
    });
    try {
      const unauthenticated = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
      });
      assert.equal(unauthenticated.status, 401);

      const authenticated = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer super-secret',
        },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
      });
      assert.equal(authenticated.status, 200);
    } finally {
      await putConfig({});
    }
  });

  test('GET /stub/last-request reflects the most recent chat-completion body', async () => {
    await putConfig({ defaults: { mode: 'loop', responses: [{ text: 'x' }] } });
    await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'remember me' }],
      }),
    });
    const res = await fetch(`${baseUrl}/stub/last-request`);
    const body = (await res.json()) as { messages: { content: string }[] };
    assert.equal(body.messages[0]?.content, 'remember me');
  });
});
