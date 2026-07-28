import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { TcpCompany } from '@tcp/shared';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'stream';
import type { Repository } from 'typeorm';
import type { AuditService } from '../audit/audit.service';
import type { KnowledgeReindexService } from '../rag/knowledge-reindex.service';
import { MinioStorageAdapter } from './minio-storage.adapter';
import { StorageSideEffects } from './storage-side-effects.service';
import { DocumentValidationException } from './document-validation.exception';

jest.mock('@aws-sdk/client-s3', () => {
  const actual =
    jest.requireActual<typeof import('@aws-sdk/client-s3')>(
      '@aws-sdk/client-s3',
    );
  return { ...actual, S3Client: jest.fn() };
});

function makeConfig(overrides: Record<string, string> = {}): ConfigService {
  const vals: Record<string, string> = {
    MINIO_ENDPOINT: 'http://localhost:9000',
    MINIO_ACCESS_KEY: 'minioadmin',
    MINIO_SECRET_KEY: 'minioadmin',
    ...overrides,
  };
  return {
    getOrThrow: jest.fn((k: string) => vals[k]),
    get: jest.fn((k: string) => vals[k]),
  } as unknown as ConfigService;
}

function makeReadable(text: string): Readable {
  const r = new Readable({ read() {} });
  r.push(text);
  r.push(null);
  return r;
}

/** `record` mock for the injected `AuditService`. */
function makeAudit(): { record: jest.Mock } {
  return { record: jest.fn().mockResolvedValue(undefined) };
}

/** `findOneBy` mock for the injected `TcpCompany` repository; resolves a company by default. */
function makeCompanyRepo(
  company: { id: string } | null = { id: 'company-uuid-1' },
): { findOneBy: jest.Mock } {
  return { findOneBy: jest.fn().mockResolvedValue(company) };
}

/** `bumpByKey` mock for the injected {@link KnowledgeReindexService} write hook. */
function makeReindex(): { bumpByKey: jest.Mock } {
  return { bumpByKey: jest.fn().mockResolvedValue(undefined) };
}

function makeAdapter(
  config: ConfigService,
  audit = makeAudit(),
  companyRepo = makeCompanyRepo(),
  reindex = makeReindex(),
): MinioStorageAdapter {
  return new MinioStorageAdapter(
    config,
    new StorageSideEffects(
      audit as unknown as AuditService,
      companyRepo as unknown as Repository<TcpCompany>,
      reindex as unknown as KnowledgeReindexService,
    ),
  );
}

const VALID_OKF = '---\ntitle: Report\n---\n\ncontent';

describe('MinioStorageAdapter', () => {
  let send: jest.Mock;

  beforeEach(() => {
    send = jest.fn();
    jest
      .mocked(S3Client)
      .mockImplementation(() => ({ send }) as unknown as S3Client);
  });

  afterEach(() => jest.clearAllMocks());

  describe('onModuleInit', () => {
    it('does not throw when the bucket already exists', async () => {
      send.mockResolvedValue({});
      const svc = makeAdapter(makeConfig());
      await expect(svc.onModuleInit()).resolves.not.toThrow();
      expect(send).toHaveBeenCalledWith(expect.any(HeadBucketCommand));
    });

    it('creates the bucket when HeadBucket returns NoSuchBucket', async () => {
      const noSuch = Object.assign(new Error('not found'), {
        name: 'NoSuchBucket',
      });
      send.mockRejectedValueOnce(noSuch).mockResolvedValue({});
      const svc = makeAdapter(makeConfig());
      await svc.onModuleInit();
      expect(send).toHaveBeenCalledTimes(2);
    });
  });

  const ROLE_SCOPE = { companySlug: 'acme', roleSlug: 'analyst' };
  const SHARED_SCOPE = { companySlug: 'acme', roleSlug: null };

  describe('putKnowledgeFile', () => {
    it('calls PutObject with the correct key and returns it', async () => {
      send.mockResolvedValue({});
      const svc = makeAdapter(makeConfig());
      const key = await svc.putKnowledgeFile(
        ROLE_SCOPE,
        'report.md',
        VALID_OKF,
      );
      expect(key).toBe('acme/knowledge/analyst/report.md');
      expect(send).toHaveBeenCalledWith(expect.any(PutObjectCommand));
    });

    it('builds the shared-scope key when roleSlug is null', async () => {
      send.mockResolvedValue({});
      const svc = makeAdapter(makeConfig());
      const key = await svc.putKnowledgeFile(
        SHARED_SCOPE,
        'report.md',
        VALID_OKF,
      );
      expect(key).toBe('acme/knowledge/shared/report.md');
    });

    it('rejects content that fails OKF validation and never writes it', async () => {
      const svc = makeAdapter(makeConfig());
      await expect(
        svc.putKnowledgeFile(ROLE_SCOPE, 'report.md', '# no front-matter'),
      ).rejects.toBeInstanceOf(DocumentValidationException);
      expect(send).not.toHaveBeenCalledWith(expect.any(PutObjectCommand));
    });

    it('triggers a RAG reindex for the written key', async () => {
      send.mockResolvedValue({});
      const reindex = makeReindex();
      const svc = makeAdapter(
        makeConfig(),
        makeAudit(),
        makeCompanyRepo(),
        reindex,
      );
      await svc.putKnowledgeFile(ROLE_SCOPE, 'report.md', VALID_OKF);
      expect(reindex.bumpByKey).toHaveBeenCalledWith(
        'acme/knowledge/analyst/report.md',
      );
    });

    it('does not fail the write when the reindex trigger throws', async () => {
      send.mockResolvedValue({});
      const reindex = makeReindex();
      reindex.bumpByKey.mockRejectedValue(new Error('redis down'));
      const svc = makeAdapter(
        makeConfig(),
        makeAudit(),
        makeCompanyRepo(),
        reindex,
      );
      await expect(
        svc.putKnowledgeFile(ROLE_SCOPE, 'report.md', VALID_OKF),
      ).resolves.toBe('acme/knowledge/analyst/report.md');
    });

    it('records a storage audit event with a real company id', async () => {
      send.mockResolvedValue({});
      const audit = makeAudit();
      const companyRepo = makeCompanyRepo({ id: 'company-uuid-1' });
      const svc = makeAdapter(makeConfig(), audit, companyRepo);
      await svc.putKnowledgeFile(ROLE_SCOPE, 'report.md', VALID_OKF, {
        user: 'user-1',
        agent: null,
        task: null,
      });
      expect(companyRepo.findOneBy).toHaveBeenCalledWith({ slug: 'acme' });
      expect(audit.record).toHaveBeenCalledWith(
        'company-uuid-1',
        'storage',
        null,
        'tool_call',
        expect.objectContaining({
          tool: 'put_knowledge_file',
          originators: { user: 'user-1', agent: null, task: null },
        }),
      );
    });

    it('skips the audit event (with a warning) when the company cannot be resolved', async () => {
      send.mockResolvedValue({});
      const audit = makeAudit();
      const companyRepo = makeCompanyRepo(null);
      const svc = makeAdapter(makeConfig(), audit, companyRepo);
      await svc.putKnowledgeFile(
        { companySlug: 'unknown-co', roleSlug: 'analyst' },
        'report.md',
        VALID_OKF,
      );
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('does not fail the write when the audit write itself throws (e.g. a stale agentId FK)', async () => {
      send.mockResolvedValue({});
      const audit = makeAudit();
      audit.record.mockRejectedValue(new Error('FK violation'));
      const svc = makeAdapter(makeConfig(), audit);
      await expect(
        svc.putKnowledgeFile(ROLE_SCOPE, 'report.md', VALID_OKF, {
          user: null,
          agent: 'stale-agent-id',
          task: null,
        }),
      ).resolves.toBe('acme/knowledge/analyst/report.md');
    });
  });

  describe('listKnowledgeFiles', () => {
    it('returns mapped StorageObject entries', async () => {
      send.mockResolvedValue({
        Contents: [
          {
            Key: 'acme/knowledge/analyst/report.md',
            Size: 512,
            LastModified: new Date('2025-01-01'),
          },
        ],
        NextContinuationToken: undefined,
      });
      const svc = makeAdapter(makeConfig());
      const files = await svc.listKnowledgeFiles(ROLE_SCOPE);
      expect(files).toHaveLength(1);
      expect(files[0].name).toBe('report.md');
      expect(files[0].size).toBe(512);
    });

    it('lists the shared-scope prefix when roleSlug is null', async () => {
      send.mockResolvedValue({
        Contents: [],
        NextContinuationToken: undefined,
      });
      const svc = makeAdapter(makeConfig());
      await svc.listKnowledgeFiles(SHARED_SCOPE);
      const [cmd] = send.mock.calls[0] as [ListObjectsV2Command];
      expect(cmd.input.Prefix).toBe('acme/knowledge/shared/');
    });

    it('paginates using NextContinuationToken', async () => {
      send
        .mockResolvedValueOnce({
          Contents: [
            {
              Key: 'acme/knowledge/analyst/a.md',
              Size: 1,
              LastModified: new Date(),
            },
          ],
          NextContinuationToken: 'tok1',
        })
        .mockResolvedValueOnce({
          Contents: [
            {
              Key: 'acme/knowledge/analyst/b.md',
              Size: 2,
              LastModified: new Date(),
            },
          ],
          NextContinuationToken: undefined,
        });
      const svc = makeAdapter(makeConfig());
      const files = await svc.listKnowledgeFiles(ROLE_SCOPE);
      expect(files).toHaveLength(2);
      expect(send).toHaveBeenCalledTimes(2);
    });
  });

  describe('getKnowledgeFile', () => {
    it('returns file content as a string', async () => {
      send.mockResolvedValue({ Body: makeReadable('hello world') });
      const svc = makeAdapter(makeConfig());
      const content = await svc.getKnowledgeFile(ROLE_SCOPE, 'report.md');
      expect(content).toBe('hello world');
    });

    it('returns null when the object does not exist', async () => {
      const noKey = Object.assign(new Error('no key'), { name: 'NoSuchKey' });
      send.mockRejectedValue(noKey);
      const svc = makeAdapter(makeConfig());
      const content = await svc.getKnowledgeFile(ROLE_SCOPE, 'missing.md');
      expect(content).toBeNull();
    });
  });

  describe('getByKey', () => {
    it('returns a stream and contentType for an existing key', async () => {
      const stream = makeReadable('binary');
      send.mockResolvedValue({ Body: stream, ContentType: 'text/plain' });
      const svc = makeAdapter(makeConfig());
      const result = await svc.getByKey('acme/tasks/x/output/file.txt');
      expect(result).not.toBeNull();
      expect(result!.contentType).toBe('text/plain');
      expect(result!.stream).toBe(stream);
    });

    it('falls back to application/octet-stream when ContentType is absent', async () => {
      send.mockResolvedValue({
        Body: makeReadable(''),
        ContentType: undefined,
      });
      const svc = makeAdapter(makeConfig());
      const result = await svc.getByKey('acme/tasks/x/output/file.bin');
      expect(result!.contentType).toBe('application/octet-stream');
    });

    it('returns null for a missing key', async () => {
      const err = Object.assign(new Error('not found'), { name: 'NotFound' });
      send.mockRejectedValue(err);
      const svc = makeAdapter(makeConfig());
      expect(await svc.getByKey('missing/key')).toBeNull();
    });

    it('rethrows unexpected errors', async () => {
      send.mockRejectedValue(new Error('connection refused'));
      const svc = makeAdapter(makeConfig());
      await expect(svc.getByKey('some/key')).rejects.toThrow(
        'connection refused',
      );
    });
  });

  describe('putByKey', () => {
    it('sends PutObjectCommand and returns byte count', async () => {
      send.mockResolvedValue({});
      const svc = makeAdapter(makeConfig());
      const buf = Buffer.from('hello');
      const size = await svc.putByKey(
        'acme/tasks/x/output/file.txt',
        buf,
        'text/plain',
      );
      expect(size).toBe(5);
      expect(send).toHaveBeenCalledWith(expect.any(PutObjectCommand));
    });

    it('passes ContentLength and ContentType through', async () => {
      let capturedInput: Record<string, unknown> | undefined;
      send.mockImplementation((cmd: unknown) => {
        capturedInput = (cmd as { input: Record<string, unknown> }).input;
        return Promise.resolve({});
      });
      const svc = makeAdapter(makeConfig());
      await svc.putByKey('acme/tasks/x/b.png', Buffer.from('img'), 'image/png');
      expect(capturedInput?.ContentType).toBe('image/png');
      expect(capturedInput?.ContentLength).toBe(3);
    });

    it('rejects content that fails validation for a recognised extension', async () => {
      const svc = makeAdapter(makeConfig());
      await expect(
        svc.putByKey(
          'acme/tasks/x/config.json',
          Buffer.from('{not valid json'),
          'application/json',
        ),
      ).rejects.toBeInstanceOf(DocumentValidationException);
      expect(send).not.toHaveBeenCalledWith(expect.any(PutObjectCommand));
    });

    it('records a storage audit event keyed off the leading path segment', async () => {
      send.mockResolvedValue({});
      const audit = makeAudit();
      const companyRepo = makeCompanyRepo({ id: 'company-uuid-1' });
      const svc = makeAdapter(makeConfig(), audit, companyRepo);
      await svc.putByKey(
        'acme/tasks/x/output/file.txt',
        Buffer.from('hello'),
        'text/plain',
      );
      expect(companyRepo.findOneBy).toHaveBeenCalledWith({ slug: 'acme' });
      expect(audit.record).toHaveBeenCalledWith(
        'company-uuid-1',
        'storage',
        null,
        'tool_call',
        expect.objectContaining({ tool: 'put_by_key' }),
      );
    });
  });

  describe('listKnowledgeFiles bucket name', () => {
    it('uses the MINIO_BUCKET_PREFIX env var when set', async () => {
      send.mockResolvedValue({
        Contents: [],
        NextContinuationToken: undefined,
      });
      const svc = makeAdapter(
        makeConfig({ MINIO_BUCKET_PREFIX: 'custom-bucket' }),
      );
      await svc.listKnowledgeFiles(ROLE_SCOPE);
      const [cmd] = send.mock.calls[0] as [ListObjectsV2Command];
      expect(cmd.input.Bucket).toBe('custom-bucket');
    });

    it('defaults to "tcp" when MINIO_BUCKET_PREFIX is not set', async () => {
      send.mockResolvedValue({
        Contents: [],
        NextContinuationToken: undefined,
      });
      const svc = makeAdapter(makeConfig());
      await svc.listKnowledgeFiles(ROLE_SCOPE);
      const [cmd] = send.mock.calls[0] as [ListObjectsV2Command];
      expect(cmd.input.Bucket).toBe('tcp');
    });
  });

  describe('listFiles', () => {
    it('lists objects under a prefix, excluding soft-deleted entries', async () => {
      send.mockResolvedValue({
        Contents: [
          { Key: 'acme/a.txt', Size: 1, LastModified: new Date() },
          {
            Key: `${'_deleted/'}acme/b.txt`,
            Size: 2,
            LastModified: new Date(),
          },
        ],
      });
      const svc = makeAdapter(makeConfig());
      const entries = await svc.listFiles('acme');
      expect(entries).toHaveLength(1);
      expect(entries[0].key).toBe('acme/a.txt');
      expect(entries[0].name).toBe('a.txt');
    });
  });

  describe('readFile', () => {
    it('returns the object content as text', async () => {
      send.mockResolvedValue({ Body: makeReadable('hello') });
      const svc = makeAdapter(makeConfig());
      expect(await svc.readFile('acme/a.txt')).toBe('hello');
    });

    it('returns null when the object does not exist', async () => {
      send.mockRejectedValue(
        Object.assign(new Error('nope'), { name: 'NoSuchKey' }),
      );
      const svc = makeAdapter(makeConfig());
      expect(await svc.readFile('acme/missing.txt')).toBeNull();
    });

    it('rejects a path containing ".."', async () => {
      const svc = makeAdapter(makeConfig());
      await expect(svc.readFile('../etc/passwd')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('writeFile', () => {
    it('writes the file and returns key and size', async () => {
      // HeadObjectCommand (objectExists check) rejects: no pre-existing file.
      send.mockImplementation((cmd: unknown) =>
        cmd instanceof HeadObjectCommand
          ? Promise.reject(new Error('not found'))
          : Promise.resolve({}),
      );
      const svc = makeAdapter(makeConfig());
      const result = await svc.writeFile('acme/a.txt', 'hello');
      expect(result).toEqual({ key: 'acme/a.txt', size: 5 });
    });

    it('refuses to overwrite an existing file by default', async () => {
      send.mockResolvedValue({}); // HeadObjectCommand (objectExists) succeeds
      const svc = makeAdapter(makeConfig());
      await expect(svc.writeFile('acme/a.txt', 'hello')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('overwrites when overwrite is true', async () => {
      send.mockResolvedValue({});
      const svc = makeAdapter(makeConfig());
      const result = await svc.writeFile('acme/a.txt', 'hello', true);
      expect(result).toEqual({ key: 'acme/a.txt', size: 5 });
    });

    it('rejects content that fails validation for a recognised extension', async () => {
      const svc = makeAdapter(makeConfig());
      await expect(
        svc.writeFile('acme/config.json', '{not valid json', true),
      ).rejects.toBeInstanceOf(DocumentValidationException);
    });
  });

  describe('deleteFile / restoreFile', () => {
    it('soft-deletes: copies to _deleted/ then removes the original', async () => {
      send.mockResolvedValue({}); // objectExists + copy + delete all resolve
      const svc = makeAdapter(makeConfig());
      await expect(svc.deleteFile('acme/a.txt')).resolves.toBeUndefined();
      expect(send).toHaveBeenCalledWith(expect.any(CopyObjectCommand));
      expect(send).toHaveBeenCalledWith(expect.any(DeleteObjectCommand));
    });

    it('throws NotFoundException when deleting a missing file', async () => {
      send.mockRejectedValue(new Error('not found'));
      const svc = makeAdapter(makeConfig());
      await expect(svc.deleteFile('acme/missing.txt')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('restores a soft-deleted file', async () => {
      send.mockResolvedValue({});
      const svc = makeAdapter(makeConfig());
      await expect(svc.restoreFile('acme/a.txt')).resolves.toBeUndefined();
    });

    it('throws NotFoundException when nothing is soft-deleted at that path', async () => {
      send.mockRejectedValue(new Error('not found'));
      const svc = makeAdapter(makeConfig());
      await expect(svc.restoreFile('acme/a.txt')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('searchFiles', () => {
    it('filters listFiles results using a glob pattern', async () => {
      send.mockResolvedValue({
        Contents: [
          { Key: 'acme/a.md', Size: 1, LastModified: new Date() },
          { Key: 'acme/b.txt', Size: 1, LastModified: new Date() },
        ],
      });
      const svc = makeAdapter(makeConfig());
      const entries = await svc.searchFiles('acme', '*.md');
      expect(entries).toHaveLength(1);
      expect(entries[0].key).toBe('acme/a.md');
    });
  });

  describe('getFileProperties', () => {
    it('returns metadata for an existing file', async () => {
      send.mockResolvedValue({
        ContentLength: 42,
        ContentType: 'text/plain',
        LastModified: new Date('2025-01-01'),
      });
      const svc = makeAdapter(makeConfig());
      const props = await svc.getFileProperties('acme/a.txt');
      expect(props).toMatchObject({
        key: 'acme/a.txt',
        exists: true,
        size: 42,
      });
    });

    it('returns exists:false for a missing file', async () => {
      send.mockRejectedValue(
        Object.assign(new Error('nope'), { name: 'NotFound' }),
      );
      const svc = makeAdapter(makeConfig());
      const props = await svc.getFileProperties('acme/missing.txt');
      expect(props).toEqual({ key: 'acme/missing.txt', exists: false });
    });
  });

  describe('copyFile / moveFile', () => {
    it('copies a file', async () => {
      send.mockResolvedValue({});
      const svc = makeAdapter(makeConfig());
      await expect(
        svc.copyFile('acme/a.txt', 'acme/b.txt'),
      ).resolves.toBeUndefined();
      expect(send).toHaveBeenCalledWith(expect.any(CopyObjectCommand));
    });

    it('throws NotFoundException when the source does not exist', async () => {
      send.mockRejectedValue(new Error('not found'));
      const svc = makeAdapter(makeConfig());
      await expect(
        svc.copyFile('acme/missing.txt', 'acme/b.txt'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('moves a file (copy then delete the source)', async () => {
      send.mockResolvedValue({});
      const svc = makeAdapter(makeConfig());
      await expect(
        svc.moveFile('acme/a.txt', 'acme/b.txt'),
      ).resolves.toBeUndefined();
      expect(send).toHaveBeenCalledWith(expect.any(CopyObjectCommand));
      expect(send).toHaveBeenCalledWith(expect.any(DeleteObjectCommand));
    });

    it('rejects a ".." destination and never calls send', async () => {
      const svc = makeAdapter(makeConfig());
      await expect(
        svc.moveFile('acme/a.txt', '../escaped.txt'),
      ).rejects.toThrow('must not contain ".."');
      expect(send).not.toHaveBeenCalled();
    });

    it('rejects a ".." source and never calls send', async () => {
      const svc = makeAdapter(makeConfig());
      await expect(
        svc.moveFile('../escaped.txt', 'acme/b.txt'),
      ).rejects.toThrow('must not contain ".."');
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('getFileSummary', () => {
    it('returns format=json-object for a JSON file', async () => {
      send.mockImplementation((cmd: unknown) => {
        if (cmd instanceof HeadObjectCommand)
          return Promise.resolve({ ContentLength: 20 });
        return Promise.resolve({ Body: makeReadable('{"a":1}') });
      });
      const svc = makeAdapter(makeConfig());
      const summary = await svc.getFileSummary('acme/config.json');
      expect(summary.format).toBe('json-object');
      expect(summary.keys).toEqual(['a']);
    });

    it('returns format=csv with columns and rowCount for a CSV file', async () => {
      send.mockImplementation((cmd: unknown) => {
        if (cmd instanceof HeadObjectCommand)
          return Promise.resolve({ ContentLength: 20 });
        return Promise.resolve({ Body: makeReadable('name,age\nAlice,30\n') });
      });
      const svc = makeAdapter(makeConfig());
      const summary = await svc.getFileSummary('acme/report.csv');
      expect(summary.format).toBe('csv');
      expect(summary.columns).toEqual(['name', 'age']);
      expect(summary.rowCount).toBe(1);
    });

    it('throws NotFoundException for a missing file', async () => {
      send.mockRejectedValue(
        Object.assign(new Error('nope'), { name: 'NoSuchKey' }),
      );
      const svc = makeAdapter(makeConfig());
      await expect(
        svc.getFileSummary('acme/missing.json'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('checkMissingFiles', () => {
    it('returns only the paths that do not exist', async () => {
      send.mockImplementation((cmd: unknown) => {
        const key = (cmd as { input: { Key: string } }).input.Key;
        return key === 'acme/missing.txt'
          ? Promise.reject(new Error('not found'))
          : Promise.resolve({});
      });
      const svc = makeAdapter(makeConfig());
      const missing = await svc.checkMissingFiles([
        'acme/exists.txt',
        'acme/missing.txt',
      ]);
      expect(missing).toEqual(['acme/missing.txt']);
    });
  });

  describe('validateExisting', () => {
    it('reports found:false for a missing file (not a validation failure)', async () => {
      send.mockRejectedValue(
        Object.assign(new Error('nope'), { name: 'NoSuchKey' }),
      );
      const svc = makeAdapter(makeConfig());
      const result = await svc.validateExisting('acme/missing.json');
      expect(result).toEqual({
        found: false,
        size: 0,
        valid: true,
        errors: [],
      });
    });

    it('re-validates an existing document using the same rules as write time', async () => {
      send.mockResolvedValue({ Body: makeReadable('{bad json') });
      const svc = makeAdapter(makeConfig());
      const result = await svc.validateExisting('acme/config.json');
      expect(result.found).toBe(true);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/not valid JSON/);
    });

    it('reports valid:true for a correctly-formed existing document', async () => {
      send.mockResolvedValue({ Body: makeReadable(VALID_OKF) });
      const svc = makeAdapter(makeConfig());
      const result = await svc.validateExisting(
        'acme/knowledge/analyst/report.md',
      );
      expect(result).toEqual({
        found: true,
        size: VALID_OKF.length,
        valid: true,
        errors: [],
      });
    });
  });

  describe('deleteKnowledgeFile', () => {
    it('delegates to deleteFile (soft-delete) at the knowledge key', async () => {
      send.mockResolvedValue({});
      const svc = makeAdapter(makeConfig());
      await svc.deleteKnowledgeFile(ROLE_SCOPE, 'report.md');
      expect(send).toHaveBeenCalledWith(expect.any(CopyObjectCommand));
      expect(send).toHaveBeenCalledWith(expect.any(DeleteObjectCommand));
    });

    it('delegates to deleteFile at the shared-scope key when roleSlug is null', async () => {
      send.mockResolvedValue({});
      const svc = makeAdapter(makeConfig());
      await svc.deleteKnowledgeFile(SHARED_SCOPE, 'report.md');
      const calls = send.mock.calls as [
        CopyObjectCommand | DeleteObjectCommand,
      ][];
      const copyCmd = calls
        .map(([cmd]) => cmd)
        .find(
          (cmd): cmd is CopyObjectCommand => cmd instanceof CopyObjectCommand,
        );
      expect(copyCmd?.input.CopySource).toContain(
        'acme/knowledge/shared/report.md',
      );
    });
  });
});
