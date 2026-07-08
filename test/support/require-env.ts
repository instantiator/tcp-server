/**
 * Returns a required environment variable, throwing a clear, actionable error
 * if it is missing. The integration and e2e tiers provision their infra env
 * vars (DATABASE_URL, REDIS_URL, ...) in Jest global setup, so a missing value
 * means the suite was run outside that lifecycle — better to fail loudly than
 * to silently skip a test that then reports a false pass.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. Integration/e2e infrastructure env vars are ` +
        `provisioned by Jest global setup — run this tier via ` +
        `'npm run test:integration' / 'npm run test:e2e' (or the matching ` +
        `scripts/run-*-tests.sh), not a bare jest invocation.`,
    );
  }
  return value;
}
