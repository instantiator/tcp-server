import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { LcpCompany } from '@lcp/shared';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditService } from '../../../apps/lcp-server/src/audit/audit.service';
import { DocumentValidationException } from '../../../apps/lcp-server/src/storage/document-validation.exception';
import { MinioStorageAdapter } from '../../../apps/lcp-server/src/storage/minio-storage.adapter';
import { requireEnv } from '../../support/require-env';

/**
 * Integration tests for {@link MinioStorageAdapter} against a real MinIO
 * instance and PostgreSQL (for company-slug resolution used by audit
 * attribution). Replaces the old `lcp-mcp-storage`-side
 * `storage-tools.integration-spec.ts`, retired since `StorageToolsService`
 * no longer talks to MinIO directly — this is the real S3-wire-protocol
 * coverage the unit tests (mocked `S3Client`) can't provide.
 *
 * MinIO and PostgreSQL are provisioned by the integration global setup;
 * MINIO_ENDPOINT and DATABASE_URL are always present.
 * Run via: ./scripts/run-integration-tests.sh
 */
const ENDPOINT = requireEnv('MINIO_ENDPOINT');
const DATABASE_URL = requireEnv('DATABASE_URL');
const BUCKET = 'lcp-storage-adapter-test';
const COMPANY_SLUG = 'acme';

async function purgeTestBucket(s3: S3Client): Promise<void> {
  const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET }));
  await Promise.all(
    (list.Contents ?? []).map((obj) =>
      s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: obj.Key! })),
    ),
  );
}

describe('MinioStorageAdapter (integration)', () => {
  let module: TestingModule;
  let adapter: MinioStorageAdapter;
  let companyRepo: Repository<LcpCompany>;
  let s3: S3Client;

  beforeAll(async () => {
    s3 = new S3Client({
      endpoint: ENDPOINT,
      region: 'us-east-1',
      credentials: {
        accessKeyId: process.env.MINIO_ACCESS_KEY ?? 'lcp-access-key',
        secretAccessKey: process.env.MINIO_SECRET_KEY ?? 'lcp-secret-key',
      },
      forcePathStyle: true,
    });

    try {
      await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    }

    module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          url: DATABASE_URL,
          entities: [LcpCompany],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([LcpCompany]),
      ],
      providers: [
        MinioStorageAdapter,
        { provide: AuditService, useValue: { record: jest.fn() } },
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: (key: string) =>
              ({
                MINIO_ENDPOINT: ENDPOINT,
                MINIO_ACCESS_KEY:
                  process.env.MINIO_ACCESS_KEY ?? 'lcp-access-key',
                MINIO_SECRET_KEY:
                  process.env.MINIO_SECRET_KEY ?? 'lcp-secret-key',
              })[key],
            get: (key: string) =>
              key === 'MINIO_BUCKET_PREFIX' ? BUCKET : undefined,
          },
        },
      ],
    }).compile();

    adapter = module.get(MinioStorageAdapter);
    companyRepo = module.get(getRepositoryToken(LcpCompany));
    await companyRepo.save(
      companyRepo.create({
        slug: COMPANY_SLUG,
        name: 'Acme',
        description: 'test',
      }),
    );
  });

  afterAll(async () => {
    await purgeTestBucket(s3);
    await companyRepo.createQueryBuilder().delete().execute();
    await module.close();
    s3.destroy();
  });

  afterEach(() => purgeTestBucket(s3));

  it('writeFile creates a new file', async () => {
    const result = await adapter.writeFile('acme/test/hello.txt', 'Hello!');
    expect(result).toEqual({ key: 'acme/test/hello.txt', size: 6 });
  });

  it('writeFile throws ConflictException when the file exists and overwrite is false', async () => {
    await adapter.writeFile('acme/test/exists.txt', 'original');
    await expect(
      adapter.writeFile('acme/test/exists.txt', 'new'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('writeFile overwrites when overwrite is true', async () => {
    await adapter.writeFile('acme/test/overwrite.txt', 'original');
    await adapter.writeFile('acme/test/overwrite.txt', 'new', true);
    expect(await adapter.readFile('acme/test/overwrite.txt')).toBe('new');
  });

  it('readFile returns file content', async () => {
    await adapter.writeFile('acme/test/read.txt', 'content here');
    expect(await adapter.readFile('acme/test/read.txt')).toBe('content here');
  });

  it('readFile returns null for a missing file', async () => {
    expect(await adapter.readFile('acme/test/missing.txt')).toBeNull();
  });

  it('deleteFile soft-deletes, making the file invisible to listFiles', async () => {
    await adapter.writeFile('acme/test/softdelete.txt', 'bye');
    await adapter.deleteFile('acme/test/softdelete.txt');

    const entries = await adapter.listFiles('acme/test/');
    expect(entries.map((e) => e.key)).not.toContain('acme/test/softdelete.txt');
  });

  it('deleteFile throws NotFoundException for a missing file', async () => {
    await expect(
      adapter.deleteFile('acme/test/never-existed.txt'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('restoreFile brings back a soft-deleted file', async () => {
    await adapter.writeFile('acme/test/restore-me.txt', 'restore me');
    await adapter.deleteFile('acme/test/restore-me.txt');
    await adapter.restoreFile('acme/test/restore-me.txt');
    expect(await adapter.readFile('acme/test/restore-me.txt')).toBe(
      'restore me',
    );
  });

  it('restoreFile throws NotFoundException when nothing is soft-deleted', async () => {
    await expect(
      adapter.restoreFile('acme/test/nope.txt'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('listFiles returns files under a prefix', async () => {
    await adapter.writeFile('acme/docs/a.md', '# A', true);
    await adapter.writeFile('acme/docs/b.md', '# B', true);
    const entries = await adapter.listFiles('acme/docs/');
    expect(entries.map((e) => e.key)).toEqual(
      expect.arrayContaining(['acme/docs/a.md', 'acme/docs/b.md']),
    );
  });

  it('searchFiles filters by glob pattern', async () => {
    await adapter.writeFile('acme/search/report.md', '# R', true);
    await adapter.writeFile('acme/search/data.json', '{}', true);
    const entries = await adapter.searchFiles('acme/search/', '*.md');
    const keys = entries.map((e) => e.key);
    expect(keys).toContain('acme/search/report.md');
    expect(keys).not.toContain('acme/search/data.json');
  });

  it('getFileProperties returns metadata for an existing file', async () => {
    await adapter.writeFile('acme/test/props.txt', 'hello world');
    const props = await adapter.getFileProperties('acme/test/props.txt');
    expect(props.exists).toBe(true);
    expect(props.size).toBeGreaterThan(0);
  });

  it('getFileProperties returns exists:false for a missing file', async () => {
    const props = await adapter.getFileProperties('acme/test/absent.txt');
    expect(props.exists).toBe(false);
  });

  it('copyFile duplicates a file at the destination, keeping the original', async () => {
    await adapter.writeFile('acme/test/original.txt', 'to copy');
    await adapter.copyFile('acme/test/original.txt', 'acme/test/copy.txt');
    expect(await adapter.readFile('acme/test/copy.txt')).toBe('to copy');
    expect(await adapter.readFile('acme/test/original.txt')).toBe('to copy');
  });

  it('moveFile moves the file and removes the original', async () => {
    await adapter.writeFile('acme/test/tomove.txt', 'moving');
    await adapter.moveFile('acme/test/tomove.txt', 'acme/test/moved.txt');
    expect(await adapter.readFile('acme/test/moved.txt')).toBe('moving');
    expect(await adapter.readFile('acme/test/tomove.txt')).toBeNull();
  });

  it('getFileSummary parses JSON structure', async () => {
    await adapter.writeFile(
      'acme/test/data.json',
      JSON.stringify({ name: 'Alice', age: 30 }),
      true,
    );
    const summary = await adapter.getFileSummary('acme/test/data.json');
    expect(summary.format).toBe('json-object');
    expect(summary.keys).toContain('name');
  });

  it('getFileSummary extracts markdown headings', async () => {
    await adapter.writeFile(
      'acme/test/doc.md',
      '# Title\n## Section\nSome text.',
      true,
    );
    const summary = await adapter.getFileSummary('acme/test/doc.md');
    expect(summary.format).toBe('markdown');
    const headings = summary.headings as Array<{
      level: number;
      text: string;
    }>;
    expect(headings[0].text).toBe('Title');
    expect(headings[1].level).toBe(2);
  });

  it('rejects a path containing ".." with BadRequestException', async () => {
    await expect(
      adapter.writeFile('acme/../secret.txt', 'evil'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects writing directly to the _deleted/ prefix', async () => {
    await expect(
      adapter.writeFile('_deleted/acme/file.txt', 'evil'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects invalid JSON content with DocumentValidationException', async () => {
    await expect(
      adapter.writeFile('acme/test/bad.json', '{invalid'),
    ).rejects.toBeInstanceOf(DocumentValidationException);
  });
});
