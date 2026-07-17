import { randomUUID, UUID } from 'crypto';
import { LcpCompany, LcpRole } from '@lcp/shared';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { RagIndexService } from './rag-index.service';
import {
  fingerprintListing,
  KnowledgeReindexService,
} from './knowledge-reindex.service';
import { StorageObject, StorageService } from '../storage/storage.service';

const COMPANY_ID = randomUUID();
const ROLE_ID = randomUUID();

const EMBEDDING_CONFIG = { provider: 'lm-studio' as const, model: 'embed' };

function makeCompany(overrides: Partial<LcpCompany> = {}): LcpCompany {
  return {
    id: COMPANY_ID,
    slug: 'acme',
    name: 'ACME',
    description: '',
    mcpServerList: [],
    nextTaskShortcodeIndex: 0,
    embeddingConfig: EMBEDDING_CONFIG,
    ...overrides,
  };
}

function makeObject(
  key: string,
  over: Partial<StorageObject> = {},
): StorageObject {
  return {
    key,
    name: key.split('/').at(-1) ?? '',
    size: 10,
    lastModified: new Date('2026-01-01T00:00:00.000Z'),
    etag: '"abc"',
    ...over,
  };
}

/** Builds a service with fully faked dependencies and a fake enqueue queue. */
function makeService() {
  const config = {
    getOrThrow: jest.fn().mockReturnValue('redis://localhost'),
    get: jest.fn().mockReturnValue(60000),
  } as unknown as ConfigService;
  const storage = {
    listKnowledgeFiles: jest.fn().mockResolvedValue([]),
    readFile: jest.fn().mockResolvedValue('content'),
  };
  const ragIndex = {
    ingestDocument: jest.fn().mockResolvedValue(undefined),
    removeDocument: jest.fn().mockResolvedValue(undefined),
  };
  const stateRepo = {
    findOne: jest.fn().mockResolvedValue({ generation: 1 }),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const chunkRepo = { find: jest.fn().mockResolvedValue([]) };
  const companyRepo = {
    findOneBy: jest.fn().mockResolvedValue(makeCompany()),
    find: jest.fn().mockResolvedValue([makeCompany()]),
  };
  const roleRepo = {
    findOneBy: jest.fn().mockResolvedValue({ id: ROLE_ID, slug: 'analyst' }),
    findBy: jest.fn().mockResolvedValue([]),
  };
  const dataSource = {
    query: jest.fn().mockResolvedValue([{ generation: 1 }]),
  } as unknown as DataSource;

  const service = new KnowledgeReindexService(
    config,
    storage as unknown as StorageService,
    ragIndex as unknown as RagIndexService,
    stateRepo as never,
    chunkRepo as never,
    companyRepo as never,
    roleRepo as never,
    dataSource,
  );
  const queue = { add: jest.fn().mockResolvedValue(undefined) };
  (service as unknown as { queue: typeof queue }).queue = queue;

  return {
    service,
    storage,
    ragIndex,
    stateRepo,
    chunkRepo,
    companyRepo,
    roleRepo,
    dataSource,
    queue,
  };
}

describe('fingerprintListing', () => {
  it('is order-independent', () => {
    const a = makeObject('acme/knowledge/shared/a.md');
    const b = makeObject('acme/knowledge/shared/b.md');
    expect(fingerprintListing([a, b])).toBe(fingerprintListing([b, a]));
  });

  it('changes when a file changes', () => {
    const a = makeObject('acme/knowledge/shared/a.md');
    const a2 = makeObject('acme/knowledge/shared/a.md', { etag: '"zzz"' });
    expect(fingerprintListing([a])).not.toBe(fingerprintListing([a2]));
  });
});

describe('KnowledgeReindexService.bumpByKey', () => {
  it('is a no-op for keys outside a knowledge folder', async () => {
    const t = makeService();
    await t.service.bumpByKey('acme/tasks/123/output.md');
    expect(t.queue.add).not.toHaveBeenCalled();
  });

  it('resolves a role slug and enqueues a rebuild carrying the new generation', async () => {
    const t = makeService();
    t.dataSource.query = jest.fn().mockResolvedValue([{ generation: 3 }]);
    await t.service.bumpByKey('acme/knowledge/analyst/report.md');
    expect(t.roleRepo.findOneBy).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      slug: 'analyst',
    });
    expect(t.queue.add).toHaveBeenCalledWith(
      'rebuild',
      { companyId: COMPANY_ID, roleId: ROLE_ID, generation: 3 },
      expect.any(Object),
    );
  });

  it('maps the shared/ folder to a null role', async () => {
    const t = makeService();
    await t.service.bumpByKey('acme/knowledge/shared/policy.md');
    expect(t.roleRepo.findOneBy).not.toHaveBeenCalled();
    expect(t.queue.add).toHaveBeenCalledWith(
      'rebuild',
      expect.objectContaining({ companyId: COMPANY_ID, roleId: null }),
      expect.any(Object),
    );
  });

  it('is a no-op when the company slug does not resolve', async () => {
    const t = makeService();
    t.companyRepo.findOneBy.mockResolvedValue(null);
    await t.service.bumpByKey('ghost/knowledge/shared/policy.md');
    expect(t.queue.add).not.toHaveBeenCalled();
  });
});

describe('KnowledgeReindexService.bumpCompany', () => {
  it('bumps the shared scope and every role', async () => {
    const t = makeService();
    t.roleRepo.findBy.mockResolvedValue([
      { id: ROLE_ID } as LcpRole,
      { id: randomUUID() } as LcpRole,
    ]);
    await t.service.bumpCompany(makeCompany());
    // shared + 2 roles
    expect(t.queue.add).toHaveBeenCalledTimes(3);
  });
});

describe('KnowledgeReindexService.rebuild', () => {
  const job = (generation: number) => ({
    data: { companyId: COMPANY_ID, roleId: null as UUID | null, generation },
  });

  it('is a no-op when the company has no embeddingConfig', async () => {
    const t = makeService();
    t.companyRepo.findOneBy.mockResolvedValue(
      makeCompany({ embeddingConfig: null }),
    );
    await t.service.rebuild(job(1));
    expect(t.storage.listKnowledgeFiles).not.toHaveBeenCalled();
  });

  it('skips a stale job whose generation is behind the current one', async () => {
    const t = makeService();
    t.stateRepo.findOne.mockResolvedValue({ generation: 5 });
    await t.service.rebuild(job(2));
    expect(t.storage.listKnowledgeFiles).not.toHaveBeenCalled();
  });

  it('indexes every file, removes stale chunks, and records the fingerprint', async () => {
    const t = makeService();
    const files = [
      makeObject('acme/knowledge/shared/a.md'),
      makeObject('acme/knowledge/shared/b.md'),
    ];
    t.storage.listKnowledgeFiles.mockResolvedValue(files);
    // An old document no longer present in the listing.
    t.chunkRepo.find.mockResolvedValue([
      { documentPath: 'acme/knowledge/shared/a.md' },
      { documentPath: 'acme/knowledge/shared/gone.md' },
    ]);
    await t.service.rebuild(job(1));

    expect(t.ragIndex.ingestDocument).toHaveBeenCalledTimes(2);
    expect(t.ragIndex.removeDocument).toHaveBeenCalledWith(
      null,
      'acme/knowledge/shared/gone.md',
    );
    expect(t.stateRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 1 }),
      { fingerprint: fingerprintListing(files) },
    );
  });

  it('aborts and re-enqueues when the generation changes mid-rebuild', async () => {
    const t = makeService();
    t.storage.listKnowledgeFiles.mockResolvedValue([
      makeObject('acme/knowledge/shared/a.md'),
      makeObject('acme/knowledge/shared/b.md'),
    ]);
    // currentGeneration reads: initial=1, before file0=1, before file1=2.
    t.stateRepo.findOne
      .mockResolvedValueOnce({ generation: 1 })
      .mockResolvedValueOnce({ generation: 1 })
      .mockResolvedValueOnce({ generation: 2 });

    await t.service.rebuild(job(1));

    // First file indexed, then aborted before the second.
    expect(t.ragIndex.ingestDocument).toHaveBeenCalledTimes(1);
    expect(t.queue.add).toHaveBeenCalledWith(
      'rebuild',
      { companyId: COMPANY_ID, roleId: null, generation: 2 },
      expect.any(Object),
    );
    expect(t.stateRepo.update).not.toHaveBeenCalled();
  });
});

describe('KnowledgeReindexService.poll', () => {
  it('bumps a scope whose listing drifted from the stored fingerprint', async () => {
    const t = makeService();
    t.roleRepo.findBy.mockResolvedValue([]); // shared scope only
    t.storage.listKnowledgeFiles.mockResolvedValue([
      makeObject('acme/knowledge/shared/a.md'),
    ]);
    t.stateRepo.findOne.mockResolvedValue({ fingerprint: 'stale' });
    await t.service.poll();
    expect(t.queue.add).toHaveBeenCalledWith(
      'rebuild',
      expect.objectContaining({ companyId: COMPANY_ID, roleId: null }),
      expect.any(Object),
    );
  });

  it('does not bump an empty, never-indexed scope', async () => {
    const t = makeService();
    t.roleRepo.findBy.mockResolvedValue([]);
    t.storage.listKnowledgeFiles.mockResolvedValue([]);
    t.stateRepo.findOne.mockResolvedValue(null);
    await t.service.poll();
    expect(t.queue.add).not.toHaveBeenCalled();
  });

  it('does not bump when the fingerprint still matches', async () => {
    const t = makeService();
    t.roleRepo.findBy.mockResolvedValue([]);
    const files = [makeObject('acme/knowledge/shared/a.md')];
    t.storage.listKnowledgeFiles.mockResolvedValue(files);
    t.stateRepo.findOne.mockResolvedValue({
      fingerprint: fingerprintListing(files),
    });
    await t.service.poll();
    expect(t.queue.add).not.toHaveBeenCalled();
  });

  it('skips companies without an embeddingConfig', async () => {
    const t = makeService();
    t.companyRepo.find.mockResolvedValue([
      makeCompany({ embeddingConfig: null }),
    ]);
    await t.service.poll();
    expect(t.storage.listKnowledgeFiles).not.toHaveBeenCalled();
  });
});
