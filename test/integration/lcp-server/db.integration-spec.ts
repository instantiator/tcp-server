import { DataSource } from 'typeorm';
import { requireEnv } from '../../support/require-env';

// PostgreSQL is provisioned by the integration global setup; DATABASE_URL is
// always present. Run via: ./scripts/run-integration-tests.sh
describe('Database connectivity', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = new DataSource({ type: 'postgres', url: requireEnv('DATABASE_URL') });
    await ds.initialize();
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.destroy();
    }
  });

  it('connects to PostgreSQL', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result = await ds.query('SELECT 1 AS ok');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(result[0].ok).toBe(1);
  });

  it('has pgvector extension available', async () => {
    // pg_available_extensions lists what can be installed; pg_extension only
    // lists what has already been created (which requires migrations to have run).
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result = await ds.query(
      `SELECT name FROM pg_available_extensions WHERE name = 'vector'`,
    );
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(result.length).toBeGreaterThan(0);
  });
});
