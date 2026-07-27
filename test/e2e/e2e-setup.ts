// Infrastructure connection vars (DATABASE_URL, REDIS_URL, MINIO_ENDPOINT) and
// the OIDC/MinIO/internal-auth config are provisioned by the e2e global setup
// (test/e2e/global-setup.ts): it starts the containers on random ports and
// loads .env.testing, so those values are already in process.env by the time
// this per-worker setup runs. Only the two stubs NOT present in .env.testing
// are set here. Running the suite directly (bare jest) now provisions infra
// via global setup too, so it no longer hangs on an unreachable Redis.
process.env.OIDC_JWKS_URI ||= 'http://localhost:8080/stub-jwks';
process.env.TCP_STORAGE_URL ||= 'http://localhost:3010';
