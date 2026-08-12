import express from 'express';
import request from 'supertest';

/**
 * The gate for `test/support/supertest-error-detail.ts`, which patches a
 * **private** supertest method (`_assertStatus`) so a failed status assertion
 * carries the response body.
 *
 * Without this, a supertest upgrade that renamed or restructured that method
 * would silently stop the patch applying: nothing would fail, every assertion
 * would keep working, and the next person debugging an intermittent 4xx would
 * simply find no explanation in the output and not know one was ever meant to
 * be there. That is precisely the class of quiet regression the patch exists to
 * prevent, so it gets a test rather than a comment.
 *
 * Uses a bare express app rather than the tcp-server application: what is under
 * test is the assertion machinery, and a real app would drag in a database for
 * no added confidence.
 */
describe('supertest failure detail (e2e)', () => {
  const app = express();
  app.get('/json-error', (_req, res) => {
    res.status(400).json({
      statusCode: 400,
      message: ['agentId must be a UUID'],
      error: 'Bad Request',
    });
  });
  app.get('/text-error', (_req, res) => {
    res.status(500).type('text/plain').send('upstream exploded');
  });
  app.get('/empty-error', (_req, res) => {
    res.status(204).send();
  });

  /** Runs an assertion expected to fail, and returns the error it produced. */
  async function failureOf(path: string, expected: number): Promise<Error> {
    try {
      await request(app).get(path).expect(expected);
    } catch (error) {
      return error as Error;
    }
    throw new Error(
      `Expected the assertion on ${path} to fail, but it passed.`,
    );
  }

  it("includes a JSON body's message in the failure", async () => {
    const error = await failureOf('/json-error', 200);

    // The terse original is still there — the patch adds to it, so existing
    // expectations about the message's shape are not invalidated.
    expect(error.message).toContain('expected 200');
    expect(error.message).toContain('got 400');
    // And the part that actually explains the refusal.
    expect(error.message).toContain('agentId must be a UUID');
  });

  it('falls back to the raw text when the body is not JSON', async () => {
    const error = await failureOf('/text-error', 200);

    expect(error.message).toContain('upstream exploded');
  });

  it('adds nothing when the response carried no explanation', async () => {
    const error = await failureOf('/empty-error', 200);

    // A 204 has nothing to say, and inventing "{}" would suggest the server
    // answered when it did not.
    expect(error.message).not.toContain('Response body');
    expect(error.message).not.toContain('Response text');
  });

  it('leaves a passing assertion untouched', async () => {
    await request(app).get('/empty-error').expect(204);
  });
});
