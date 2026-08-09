import { describe, expect, it } from 'vitest';

// The generated file as text, through Vite's `?raw`. These assertions are
// about what the generator *wrote*, not about the types it produced: a route
// the server never declared a body for arrives here as a perfectly valid
// TypeScript type meaning "nothing", so nothing type-level can see it.
import schemaSource from './schema.d.ts?raw';

/**
 * Guards against a route reaching the web client with no readable response.
 *
 * Two ways that has happened, both silent at the cause and both surfacing only
 * as a compile error at some call site in another package, months later:
 *
 * - **A handler with no `@ApiOkResponse`.** Nest publishes the operation with
 *   no response body and `openapi-typescript` renders it `content?: never`.
 *   `GET /api/task/{id}` and `GET /api/conversation/{slug}` were both like this
 *   until 007.02 — keyed, cached, live-patched and completely unreadable.
 * - **A DTO the Swagger plugin never visited.** Until 006.01 its
 *   `dtoFileNameSuffix` did not match `*.model.ts`, so eight entities were
 *   published as empty objects and rendered `Record<string, never>`.
 *
 * The parser below matches braces rather than indentation. The first version
 * of this file keyed on the number of leading spaces, got it wrong by four,
 * matched nothing, and passed — which is the failure mode a guard like this
 * has to be designed against, not merely avoid by luck. Hence
 * `detects a route with no declared body`: the parser is proved against a
 * sample containing a known-bad operation before it is trusted on the real
 * file.
 */

/**
 * Blanks the contents of every string literal, leaving length and structure
 * intact so indexes still line up with the original.
 *
 * Without this the scanners below miscount: a path key is a string containing
 * braces (`"/api/company/{id}"`), and counting those as block delimiters
 * corrupted the depth for every parameterised route — 13 of the 44 paths, and
 * silently, because the ones that survived looked like a working parser.
 */
const blankStrings = (source: string): string =>
  source.replace(/"[^"\n]*"/g, (match) => `"${' '.repeat(match.length - 2)}"`);

/** The body of the `{ … }` block that opens at or after `from`. */
const blockAt = (source: string, from: number, scan = blankStrings(source)) => {
  const open = scan.indexOf('{', from);
  if (open === -1) return '';

  let depth = 0;
  for (let i = open; i < scan.length; i += 1) {
    if (scan[i] === '{') depth += 1;
    else if (scan[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return '';
};

/**
 * The `key: { … }` members directly inside a block, ignoring nested ones.
 *
 * Quoted keys (the paths, `"/api/company/{id}"`) come back without quotes.
 */
const members = (block: string): Map<string, string> => {
  const found = new Map<string, string>();
  const scan = blankStrings(block);
  let depth = 0;
  let keyStart = 0;

  for (let i = 0; i < scan.length; i += 1) {
    if (scan[i] === '{') {
      if (depth === 0) {
        const key = /(?:"([^"\n]*)"|([\w-]+))\??:\s*$/.exec(
          block.slice(keyStart, i),
        );
        if (key !== null) {
          found.set(key[1] ?? key[2], blockAt(block, i, scan));
        }
      }
      depth += 1;
    } else if (scan[i] === '}') {
      depth -= 1;
      if (depth === 0) keyStart = i + 1;
    }
  }
  return found;
};

/** Every operation name, mapped to the `METHOD /path` that uses it. */
const routesByOperation = (source: string): Map<string, string> => {
  const paths = members(
    blockAt(source, source.indexOf('export interface paths')),
  );
  const routes = new Map<string, string>();

  for (const [path, body] of paths) {
    for (const [, method, operation] of body.matchAll(
      /(get|put|post|delete|patch):\s*operations\["(\w+)"\]/g,
    )) {
      routes.set(operation, `${method.toUpperCase()} ${path}`);
    }
  }
  return routes;
};

/** Operations whose 200 response declares no body at all. */
const operationsWithNoBody = (source: string): string[] => {
  const operations = members(
    blockAt(source, source.indexOf('export interface operations')),
  );
  const routes = routesByOperation(source);
  const undeclared: string[] = [];

  for (const [name, body] of operations) {
    const responses = members(body).get('responses');
    if (responses === undefined) continue;

    const success = members(responses).get('200');
    if (success !== undefined && success.includes('content?: never')) {
      undeclared.push(routes.get(name) ?? name);
    }
  }
  return undeclared;
};

/** Operations whose 200 body is an object type with no properties. */
const operationsWithEmptyBody = (source: string): string[] => {
  const operations = members(
    blockAt(source, source.indexOf('export interface operations')),
  );
  const routes = routesByOperation(source);
  const empty: string[] = [];

  for (const [name, body] of operations) {
    const responses = members(body).get('responses');
    if (responses === undefined) continue;

    const success = members(responses).get('200');
    if (success !== undefined && success.includes('Record<string, never>')) {
      empty.push(routes.get(name) ?? name);
    }
  }
  return empty;
};

/**
 * `GET /api/…` routes allowed to answer with something a component cannot
 * read as JSON.
 *
 * Exact routes rather than a pattern, so an exception stays a decision someone
 * took rather than a shape a new route can fall into. Only `/api` GETs are
 * checked at all: `/internal/*` is the agent runner's, and a POST is a command
 * rather than something a view reads.
 */
const NOT_READ_AS_JSON: readonly string[] = [
  // Server-sent event streams. The body is a stream of events, not a value,
  // and `@Sse` has no response type to declare. The browser reads these
  // through `src/events/`, never through a hook.
  'GET /api/company/{id}/events',
  'GET /api/task/{id}/events',
  'GET /api/agent/{id}/events',
  // Streams a stored object straight through to the caller.
  'GET /api/storage',
  // Admin-only, and nothing in the web client reads it. Genuinely undescribed
  // rather than deliberately so — give it an `@ApiOkResponse` if a view ever
  // needs it.
  'GET /api/system/shutdown',
];

/** Only the routes a component could read through a hook. */
const isBrowserRead = (route: string): boolean =>
  route.startsWith('GET /api/') && !NOT_READ_AS_JSON.includes(route);

describe('the generated API schema', () => {
  it('detects a route with no declared body', () => {
    // The parser, proved against a sample before it is trusted on the real
    // file. `good` and `bad` differ only in the way the two routes 007.02
    // fixed differed from their siblings.
    // `{id}` in the bad path is not decoration: braces inside a path key are
    // what broke the first parser, and every route with one went unchecked.
    const sample = `
export interface paths {
    "/api/good": {
        get: operations["Thing_good"];
    };
    "/api/bad/{id}": {
        get: operations["Thing_bad"];
    };
}
export interface operations {
    Thing_good: {
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ThingDto"];
                };
            };
        };
    };
    Thing_bad: {
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
}
`;
    expect(operationsWithNoBody(sample)).toEqual(['GET /api/bad/{id}']);
  });

  it('reads the real schema, so a generator change fails loudly', () => {
    // Without this, a change to the generated file's shape would empty every
    // list below and the suite would pass by finding nothing — which is
    // exactly what the first version of this file did.
    const routes = routesByOperation(schemaSource);
    expect(routes.size).toBeGreaterThan(50);
    expect([...routes.values()]).toContain('GET /api/task/{id}');
  });

  it('declares a response body for every GET a component reads', () => {
    // The fix is `@ApiOkResponse({ type: SomethingResponseDto })` on the
    // handler, then `npm run api:generate`. If the route genuinely answers
    // with something other than JSON, add it to NOT_READ_AS_JSON with a reason.
    expect(operationsWithNoBody(schemaSource).filter(isBrowserRead)).toEqual(
      [],
    );
  });

  it('never renders one of those as an object with no properties', () => {
    // `Record<string, never>` means the Swagger plugin published a type with
    // no properties. Two causes, both real here: a handler returning an
    // **interface**, which is erased before the plugin can read it and needs a
    // DTO class (the five knowledge routes, until 007.02), or a DTO in a file
    // `dtoFileNameSuffix` in `nest-cli.json` does not match (`*.model.ts`,
    // until 006.01).
    expect(operationsWithEmptyBody(schemaSource).filter(isBrowserRead)).toEqual(
      [],
    );
  });

  it('keeps the allowlist honest', () => {
    // An entry that no longer needs to be there hides a real regression behind
    // it, so every exception must still be an exception.
    const undescribed = new Set([
      ...operationsWithNoBody(schemaSource),
      ...operationsWithEmptyBody(schemaSource),
    ]);
    expect(NOT_READ_AS_JSON.filter((route) => !undescribed.has(route))).toEqual(
      [],
    );
  });
});
