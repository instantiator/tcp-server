import http from 'http';
import type { AddressInfo } from 'net';
import type { INestApplication } from '@nestjs/common';

/**
 * Opens a raw HTTP GET to an SSE endpoint on a *listening* Nest app
 * (`await app.listen(0)` — supertest's buffered `request(app.getHttpServer())`
 * can't observe a long-lived stream) and collects parsed `data:` JSON
 * payloads until `count` have arrived (or `timeoutMs` elapses), then aborts
 * the connection.
 */
export function consumeSse<T>(
  app: INestApplication,
  path: string,
  headers: Record<string, string>,
  count: number,
  timeoutMs = 5000,
): Promise<T[]> {
  const server = app.getHttpServer() as http.Server;
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const events: T[] = [];
    let buffer = '';
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(events);
    };

    const timer = setTimeout(finish, timeoutMs);

    const req = http.get(
      { host: '127.0.0.1', port: address.port, path, headers },
      (res) => {
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          let boundary: number;
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const dataLine = raw
              .split('\n')
              .find((line) => line.startsWith('data:'));
            if (dataLine) {
              // A stream that errors before emitting anything (e.g. an
              // unknown id) may write a non-JSON error message rather than a
              // proper `{ data: <event> }` frame — ignore, don't crash.
              try {
                events.push(
                  JSON.parse(dataLine.slice('data:'.length).trim()) as T,
                );
              } catch {
                continue;
              }
              if (events.length >= count) {
                finish();
                return;
              }
            }
          }
        });
        res.on('error', (err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
        });
      },
    );
    req.on('error', (err) => {
      // A destroyed request emits an error after we've already resolved —
      // only reject if we haven't settled yet.
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}
