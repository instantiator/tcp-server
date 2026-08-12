// Infrastructure connection vars (DATABASE_URL, REDIS_URL, MINIO_ENDPOINT) and
// the OIDC/MinIO/internal-auth config are provisioned by the e2e global setup
// (test/e2e/global-setup.ts): it starts the containers on random ports and
// loads .env.testing, so those values are already in process.env by the time
// this per-worker setup runs. Only the two stubs NOT present in .env.testing
// are set here. Running the suite directly (bare jest) now provisions infra
// via global setup too, so it no longer hangs on an unreachable Redis.
// Failed status assertions carry the server's own explanation — see the module
// for why this is patched centrally rather than adopted per call site.
import '../support/supertest-error-detail';

process.env.OIDC_JWKS_URI ||= 'http://localhost:8080/stub-jwks';
process.env.TCP_STORAGE_URL ||= 'http://localhost:3010';

// `jest-e2e.json` sets `testTimeout: 30000`, matching the integration tier —
// noted here because JSON cannot carry the reason.
//
// Jest's default is 5 seconds, and it applies to hooks as well as tests. Every
// spec in this tier boots a full Nest application and talks to Postgres, Redis
// and MinIO in Docker, and several `afterEach` hooks issue an HTTP request plus
// four table deletes. Five seconds is comfortable on an idle machine and not
// comfortable on a busy one, which made this tier fail roughly one run in five
// — always in a different spec, because whichever hook happened to be running
// when the machine got busy was the one that lost.
//
// The integration tier was given 30s at some earlier point; this tier was
// simply never given the same treatment, and it is the heavier of the two.
// Raising it does not hide a slow test: nothing here legitimately takes 30
// seconds, so a hook that reaches the new limit is a genuine hang worth
// failing on, rather than a spike in machine load.
