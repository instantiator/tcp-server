import { DataSource, QueryRunner } from 'typeorm';
import { BaselineSchema1784790000000 } from '../../../apps/lcp-server/src/migrations/1784790000000-BaselineSchema';
import { DynamicEmbeddingDimension1784800000000 } from '../../../apps/lcp-server/src/migrations/1784800000000-DynamicEmbeddingDimension';
import { DEFAULT_EMBEDDING_DIMENSION } from '../../../libs/lcp-shared/src/config/defaults';
import { requireEnv } from '../../support/require-env';

// PostgreSQL is provisioned by the integration global setup; DATABASE_URL is
// always present. Run via: ./scripts/run-integration-tests.sh
//
// Applies both migrations into a dedicated schema rather than `public`, which
// other specs populate via `synchronize: true` in an order this spec cannot
// rely on. That isolation is what lets the baseline be exercised the way it is
// in production — plain CREATEs against an empty schema — so a baseline that
// only applies to an already-populated database fails here instead of passing.
describe('Baseline schema (migration verification)', () => {
  const SCHEMA = 'baseline_verification';

  let ds: DataSource;
  let runner: QueryRunner;

  beforeAll(async () => {
    ds = new DataSource({ type: 'postgres', url: requireEnv('DATABASE_URL') });
    await ds.initialize();

    // Install the extensions into `public` first: the baseline creates them
    // idempotently, but under the search path below it would otherwise put
    // them in the throwaway schema and take them away with it on teardown.
    await ds.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await ds.query(`CREATE EXTENSION IF NOT EXISTS vector`);

    await ds.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ds.query(`CREATE SCHEMA "${SCHEMA}"`);

    // A reserved connection, so the search path holds for every migration
    // statement. Assertions below use the pool and must qualify the schema.
    runner = ds.createQueryRunner();
    await runner.connect();
    await runner.query(`SET search_path TO "${SCHEMA}", public`);

    await new BaselineSchema1784790000000().up(runner);
    await new DynamicEmbeddingDimension1784800000000().up(runner);
  });

  afterAll(async () => {
    if (runner) await runner.release();
    if (ds?.isInitialized) {
      await ds.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await ds.destroy();
    }
  });

  /** Columns of a table in the throwaway schema, keyed by column name. */
  async function columns(
    table: string,
  ): Promise<Map<string, { dataType: string; isNullable: string }>> {
    const rows = await ds.query<
      { column_name: string; data_type: string; is_nullable: string }[]
    >(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2`,
      [SCHEMA, table],
    );
    return new Map(
      rows.map((r) => [
        r.column_name,
        { dataType: r.data_type, isNullable: r.is_nullable },
      ]),
    );
  }

  it('creates every expected table from an empty schema', async () => {
    const rows = await ds.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 ORDER BY table_name`,
      [SCHEMA],
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'audit_event',
      'company_user',
      'conversation',
      'conversation_message',
      'episodic_memory',
      'knowledge_chunk',
      'knowledge_index_state',
      'lcp_agent',
      'lcp_assignment',
      'lcp_company',
      'lcp_role',
      'lcp_task',
      'pending_consultation',
    ]);
  });

  it('lcp_agent has an output column of type text', async () => {
    expect((await columns('lcp_agent')).get('output')?.dataType).toBe('text');
  });

  it('lcp_agent has a nullable requiredToolCalls column of type text', async () => {
    expect((await columns('lcp_agent')).get('requiredToolCalls')).toEqual({
      dataType: 'text',
      isNullable: 'YES',
    });
  });

  it('lcp_agent has a nullable pausedAt column', async () => {
    expect((await columns('lcp_agent')).get('pausedAt')?.isNullable).toBe(
      'YES',
    );
  });

  it('pending_consultation table exists with expected columns', async () => {
    const cols = [...(await columns('pending_consultation')).keys()];
    expect(cols).toEqual(
      expect.arrayContaining([
        'id',
        'callingAgentId',
        'consultationAgentId',
        'companyId',
        'status',
        'result',
        'createdAt',
      ]),
    );
  });

  it('pending_consultation.status defaults to pending', async () => {
    const rows = await ds.query<{ column_default: string }[]>(
      `SELECT column_default FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'pending_consultation'
         AND column_name = 'status'`,
      [SCHEMA],
    );
    expect(rows[0].column_default).toContain('pending');
  });

  it('pending_consultation has its agent and calling indexes', async () => {
    const rows = await ds.query<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = $1 AND tablename = 'pending_consultation'
       ORDER BY indexname`,
      [SCHEMA],
    );
    expect(rows.map((r) => r.indexname)).toEqual(
      expect.arrayContaining([
        'idx_pending_consultation_agent',
        'idx_pending_consultation_calling',
      ]),
    );
  });

  it('sizes both vector columns to the default embedding dimension', async () => {
    const rows = await ds.query<{ relname: string; typename: string }[]>(
      `SELECT c.relname, format_type(a.atttypid, a.atttypmod) AS typename
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND a.attname = 'embedding' AND c.relkind = 'r'
       ORDER BY c.relname`,
      [SCHEMA],
    );
    expect(rows).toEqual([
      {
        relname: 'episodic_memory',
        typename: `vector(${DEFAULT_EMBEDDING_DIMENSION})`,
      },
      {
        relname: 'knowledge_chunk',
        typename: `vector(${DEFAULT_EMBEDDING_DIMENSION})`,
      },
    ]);
  });
});
