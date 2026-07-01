import { DataSource } from 'typeorm';
import { AddAgentOutputAndConsultation1782247400000 } from '../../../apps/lcp-server/src/migrations/1782247400000-AddAgentOutputAndConsultation';
import { AddAgentPausedAt1782831650682 } from '../../../apps/lcp-server/src/migrations/1782831650682-AddAgentPausedAt';

// Requires DATABASE_URL pointing to a running PostgreSQL instance.
// Run via: ./scripts/run-integration-tests.sh
//
// Calls the migration's up() method directly (idempotent — uses IF NOT EXISTS)
// to create the schema, then verifies the resulting DB state.
describe('Pause-and-resume schema (migration verification)', () => {
  let ds: DataSource;
  let skip = false;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url || url.startsWith('sqlite')) {
      skip = true;
      return;
    }
    ds = new DataSource({ type: 'postgres', url });
    await ds.initialize();

    // Ensure lcp_agent exists before the migration tries to ALTER it.
    // Other integration specs may have already created it via synchronize:true,
    // but ordering is not guaranteed so we create it idempotently.
    await ds.query(`
      CREATE TABLE IF NOT EXISTS lcp_agent (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" VARCHAR NOT NULL,
        "roleId"    VARCHAR NOT NULL,
        status      VARCHAR NOT NULL DEFAULT 'idle',
        "threadId"  VARCHAR,
        "initialPrompt" TEXT NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Run the migrations directly — idempotent, no tracking table needed
    const runner = ds.createQueryRunner();
    await runner.connect();
    try {
      await new AddAgentOutputAndConsultation1782247400000().up(runner);
      await new AddAgentPausedAt1782831650682().up(runner);
    } finally {
      await runner.release();
    }
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  it('lcp_agent has an output column of type text', async () => {
    if (skip) return console.log('Skipping — no postgres DATABASE_URL');

    const rows = await ds.query<{ column_name: string; data_type: string }[]>(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'lcp_agent' AND column_name = 'output'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe('text');
  });

  it('pending_consultation table exists with expected columns', async () => {
    if (skip) return console.log('Skipping — no postgres DATABASE_URL');

    const rows = await ds.query<{ column_name: string }[]>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'pending_consultation'
      ORDER BY column_name
    `);
    const cols = rows.map((r) => r.column_name);
    expect(cols).toContain('id');
    expect(cols).toContain('callingAgentId');
    expect(cols).toContain('consultationAgentId');
    expect(cols).toContain('companyId');
    expect(cols).toContain('status');
    expect(cols).toContain('result');
    expect(cols).toContain('createdAt');
  });

  it('pending_consultation has an index on consultationAgentId', async () => {
    if (skip) return console.log('Skipping — no postgres DATABASE_URL');

    const rows = await ds.query<{ indexname: string }[]>(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'pending_consultation'
        AND indexname = 'idx_pending_consultation_agent'
    `);
    expect(rows).toHaveLength(1);
  });

  it('pending_consultation has a composite index on (callingAgentId, status)', async () => {
    if (skip) return console.log('Skipping — no postgres DATABASE_URL');

    const rows = await ds.query<{ indexname: string }[]>(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'pending_consultation'
        AND indexname = 'idx_pending_consultation_calling'
    `);
    expect(rows).toHaveLength(1);
  });

  it('pending_consultation.status defaults to pending', async () => {
    if (skip) return console.log('Skipping — no postgres DATABASE_URL');

    const rows = await ds.query<{ column_default: string }[]>(`
      SELECT column_default
      FROM information_schema.columns
      WHERE table_name = 'pending_consultation' AND column_name = 'status'
    `);
    expect(rows[0].column_default).toContain('pending');
  });

  it('lcp_agent has a nullable pausedAt column', async () => {
    if (skip) return console.log('Skipping — no postgres DATABASE_URL');

    const rows = await ds.query<{ is_nullable: string }[]>(`
      SELECT is_nullable
      FROM information_schema.columns
      WHERE table_name = 'lcp_agent' AND column_name = 'pausedAt'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].is_nullable).toBe('YES');
  });
});
