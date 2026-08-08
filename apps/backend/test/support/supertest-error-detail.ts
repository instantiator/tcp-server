import { Response, Test } from 'supertest';

/**
 * Makes a failed supertest status assertion say **why** the server refused.
 *
 * Out of the box, `.expect(200)` fails with `expected 200 "OK", got 400 "Bad
 * Request"` and nothing else — the response body, which is where the server
 * explained itself, is discarded. tcp-server has no custom exception filter, so
 * Nest's default already puts `{ statusCode, message, error }` on the wire, and
 * `ValidationPipe` puts the specific field errors in `message`. All of that was
 * being thrown away at the assertion.
 *
 * That cost real time: an intermittent `400` in the orchestration e2e spec had
 * to be traced by reading service source and eliminating every branch that
 * could return one, when the body would have named the failing field at once.
 *
 * Patched centrally rather than by changing call sites. There are several
 * hundred `.expect(<status>)` calls across the e2e and api tiers; a helper each
 * one had to adopt would have covered whichever ones people remembered, which
 * is the opposite of what a diagnostic aid is for.
 *
 * **This patches a private method.** `_assertStatus` is not part of supertest's
 * published API and is absent from its types, so a major upgrade could rename
 * it. The failure mode is benign and loud in the right way: the wrapper simply
 * stops being called and assertions go back to their terse message — no test
 * changes behaviour, nothing silently passes. `supertest-error-detail.spec.ts`
 * asserts the body still reaches the message, so an upgrade that breaks this
 * fails a test rather than quietly degrading everyone's debugging.
 */

/**
 * The private assertion methods this module wraps.
 *
 * Declared as function-valued **properties** rather than method signatures, and
 * carrying their own `this`. Both details matter: the wrapper has to read each
 * original off the prototype before replacing it, and reading a method
 * signature off a prototype is exactly what `@typescript-eslint/unbound-method`
 * exists to catch. Typing them this way says what is actually true — these are
 * slots on the prototype holding functions that expect a `Test` receiver — so
 * the rule is satisfied by the declaration being honest rather than silenced.
 */
interface SupertestStatusAssertions {
  _assertStatus: (
    this: Test,
    status: number,
    res: Response,
  ) => Error | undefined;
  _assertStatusArray: (
    this: Test,
    statuses: number[],
    res: Response,
  ) => Error | undefined;
}

/** How much of a non-JSON body to include before it stops being a clue. */
const MAX_TEXT_LENGTH = 2000;

/**
 * Renders whatever the server sent back, preferring the parsed body and
 * falling back to raw text. Returns an empty string when there is nothing to
 * add, so a genuinely empty response does not grow a misleading "{}".
 */
function describeBody(res: Response): string {
  const body: unknown = res.body;

  if (
    body !== null &&
    typeof body === 'object' &&
    Object.keys(body).length > 0
  ) {
    return `\nResponse body:\n${JSON.stringify(body, null, 2)}`;
  }

  const text = typeof res.text === 'string' ? res.text.trim() : '';
  if (text.length === 0) return '';

  return text.length > MAX_TEXT_LENGTH
    ? `\nResponse text (truncated):\n${text.slice(0, MAX_TEXT_LENGTH)}…`
    : `\nResponse text:\n${text}`;
}

/** Appends the server's own explanation to a failed status assertion. */
function withBody(error: Error | undefined, res: Response): Error | undefined {
  if (error === undefined) return error;
  error.message += describeBody(res);
  return error;
}

const proto = Test.prototype as unknown as SupertestStatusAssertions;
const assertStatus = proto._assertStatus;
const assertStatusArray = proto._assertStatusArray;

proto._assertStatus = function (this: Test, status: number, res: Response) {
  return withBody(assertStatus.call(this, status, res), res);
};

proto._assertStatusArray = function (
  this: Test,
  statuses: number[],
  res: Response,
) {
  return withBody(assertStatusArray.call(this, statuses, res), res);
};
