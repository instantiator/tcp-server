import { DataSource } from 'typeorm';

// Requires DATABASE_URL pointing to a running PostgreSQL instance.
// Run via: ./scripts/run-integration-tests.sh
describe('Database connectivity', () => {
  let ds: DataSource;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url || url.startsWith('sqlite')) {
      return;
    }
    ds = new DataSource({ type: 'postgres', url });
    await ds.initialize();
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.destroy();
    }
  });

  it('connects to PostgreSQL', async () => {
    if (!ds?.isInitialized) {
      console.log('Skipping — no postgres DATABASE_URL set');
      return;
    }
    const result = await ds.query('SELECT 1 AS ok');
    expect(result[0].ok).toBe(1);
  });

  it('has pgvector extension available', async () => {
    if (!ds?.isInitialized) {
      return;
    }
    // pg_available_extensions lists what can be installed; pg_extension only
    // lists what has already been created (which requires migrations to have run).
    const result = await ds.query(
      `SELECT name FROM pg_available_extensions WHERE name = 'vector'`,
    );
    expect(result.length).toBeGreaterThan(0);
  });
});
