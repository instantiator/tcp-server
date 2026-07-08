import { createClient } from 'redis';

/**
 * Removes any password from a Redis URL so it can be shown in an error message
 * without leaking credentials.
 */
function redactRedisUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Verifies that Redis at {@link url} is reachable, failing fast rather than
 * hanging. BullMQ (and its ioredis connection) retries an unreachable Redis
 * indefinitely by default, so a service that constructs a `Queue`/`Worker`
 * against a downed Redis blocks forever instead of erroring. Services call this
 * at startup to fail with a clear, actionable message instead.
 *
 * Scope: startup-time reachability only. A connection that drops *after* a
 * healthy start is a separate resilience concern (circuit-breaking / degraded
 * mode) and is deliberately not handled here.
 *
 * @param url - The `redis://` connection URL to probe.
 * @param timeoutMs - How long to wait for the connection before giving up.
 * @throws Error if Redis cannot be reached within {@link timeoutMs}.
 */
export async function assertRedisReachable(
  url: string,
  timeoutMs = 5000,
): Promise<void> {
  const client = createClient({
    url,
    socket: {
      connectTimeout: timeoutMs,
      // Fail fast: never retry an unreachable server during this probe.
      reconnectStrategy: false,
    },
  });
  // node-redis emits 'error' on connection failure; without a listener that
  // surfaces as an unhandled rejection.
  client.on('error', () => undefined);
  try {
    await client.connect();
    await client.ping();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Redis is not reachable at ${redactRedisUrl(url)}: ${reason}. ` +
        'Check REDIS_URL and that Redis is running before starting this service.',
    );
  } finally {
    try {
      client.destroy();
    } catch {
      // Nothing to close if the connection never opened.
    }
  }
}
