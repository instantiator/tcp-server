// Fallback env vars so the Nest app can boot under e2e. These are NOT
// sufficient on their own: the suite exercises paths that require Postgres and
// Redis (BullMQ enqueue/orchestration), so run it via scripts/run-e2e-tests.sh,
// which starts those services and overrides these defaults. Running jest
// directly with no Redis will HANG — enqueues block on the unreachable broker
// until each test times out — rather than failing fast.
process.env.DATABASE_URL ||= 'sqlite::memory:';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.MINIO_ENDPOINT ||= 'http://localhost:9000';
process.env.MINIO_ACCESS_KEY ||= 'test-key';
process.env.MINIO_SECRET_KEY ||= 'test-secret';
process.env.OIDC_ISSUER_URL ||= 'http://localhost:8080/realms/lcp';
process.env.OIDC_CLIENT_ID ||= 'lcp-server';
process.env.OIDC_CLIENT_SECRET ||= 'test-secret';
// Skip OIDC discovery fetch at startup — jwks-rsa is mocked so the URI is irrelevant.
process.env.OIDC_JWKS_URI ||= 'http://localhost:8080/stub-jwks';
process.env.INTERNAL_API_KEY ||= 'e2e-test-internal-key';
// Stubs for services that communicate with other LCP services.
process.env.LCP_SERVER_URL ||= 'http://localhost:3000';
process.env.LCP_STORAGE_URL ||= 'http://localhost:3010';
