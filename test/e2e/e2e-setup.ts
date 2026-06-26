// Set stub env vars for e2e tests that run without external services.
// Real service URLs are injected by CI / run-e2e-tests.sh when available.
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
