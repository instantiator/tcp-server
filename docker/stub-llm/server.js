// Minimal OpenAI-compatible stub for integration tests.
// Responds to POST /v1/chat/completions with a configurable canned response.
// No npm dependencies — uses the Node.js built-in http module only.

const http = require('http');

const PORT = parseInt(process.env.PORT ?? '3002', 10);

// Default response returned for every chat completions request.
// Override per-test via POST /stub/config { "response": "..." }.
let stubResponse = process.env.STUB_RESPONSE ?? 'stub response';

function completionBody(content) {
  return JSON.stringify({
    id: 'chatcmpl-stub',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'stub',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  });
}

// Emits the canned response as an OpenAI-style SSE stream. Splits the content
// into word-sized deltas so streaming consumers (streamEvents) see multiple
// chunks, matching how a real provider streams tokens.
function streamCompletion(res, content) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (delta, finish) => {
    res.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-stub',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'stub',
        choices: [{ index: 0, delta, finish_reason: finish ?? null }],
      })}\n\n`,
    );
  };
  send({ role: 'assistant' });
  const words = content.split(' ');
  words.forEach((word, i) => {
    send({ content: i === 0 ? word : ` ${word}` });
  });
  send({}, 'stop');
  res.write('data: [DONE]\n\n');
  res.end();
}

http
  .createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        let wantsStream = false;
        try {
          wantsStream = JSON.parse(body).stream === true;
        } catch {
          // Non-JSON body — fall back to a non-streaming response.
        }
        if (wantsStream) {
          streamCompletion(res, stubResponse);
        } else {
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(200);
          res.end(completionBody(stubResponse));
        }
      });
      return;
    }

    res.setHeader('Content-Type', 'application/json');

    // Control endpoint — lets individual tests set the next response body
    if (req.method === 'POST' && req.url === '/stub/config') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (typeof parsed.response === 'string') {
            stubResponse = parsed.response;
          }
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, response: stubResponse }));
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'invalid JSON' }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
  })
  .listen(PORT, () => {
    console.log(`stub-llm listening on :${PORT}`);
  });
