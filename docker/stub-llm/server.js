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

http
  .createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      res.writeHead(200);
      res.end(completionBody(stubResponse));
      return;
    }

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
