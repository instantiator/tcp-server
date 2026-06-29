import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { AuditClientService } from '@lcp/shared';
import { StorageToolsService } from '../../../apps/lcp-mcp-storage/src/mcp/storage-tools.service';

// Requires MINIO_ENDPOINT pointing to a running MinIO instance.
// Run via: ./scripts/run-integration-tests.sh

const ENDPOINT = process.env.MINIO_ENDPOINT;
const BUCKET = 'lcp-storage-test';

const describeIf = ENDPOINT ? describe : describe.skip;

async function purgeTestBucket(s3: S3Client): Promise<void> {
  const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET }));
  await Promise.all(
    (list.Contents ?? []).map((obj) =>
      s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: obj.Key! })),
    ),
  );
}

describeIf('StorageToolsService (integration)', () => {
  let module: TestingModule;
  let service: StorageToolsService;
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

    // Create test bucket if it doesn't exist
    try {
      await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    }

    module = await Test.createTestingModule({
      providers: [
        StorageToolsService,
        {
          provide: AuditClientService,
          useValue: { record: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'MINIO_ENDPOINT') return ENDPOINT;
              if (key === 'MINIO_ACCESS_KEY')
                return process.env.MINIO_ACCESS_KEY ?? 'lcp-access-key';
              if (key === 'MINIO_SECRET_KEY')
                return process.env.MINIO_SECRET_KEY ?? 'lcp-secret-key';
              if (key === 'MINIO_BUCKET') return BUCKET;
              return undefined;
            },
          },
        },
      ],
    }).compile();

    service = module.get(StorageToolsService);
  });

  afterAll(async () => {
    await purgeTestBucket(s3);
    await module.close();
    s3.destroy();
  });

  afterEach(() => purgeTestBucket(s3));

  it('write_file creates a new file', async () => {
    const result = await service.writeFile('acme/test/hello.txt', 'Hello!');
    expect(result.content[0].text).toContain('Written');
  });

  it('write_file returns error when file exists and overwrite is false', async () => {
    await service.writeFile('acme/test/exists.txt', 'original');
    const result = await service.writeFile('acme/test/exists.txt', 'new');
    expect(result.content[0].text).toContain('already exists');
  });

  it('write_file overwrites when overwrite is true', async () => {
    await service.writeFile('acme/test/overwrite.txt', 'original');
    const result = await service.writeFile(
      'acme/test/overwrite.txt',
      'new',
      true,
    );
    expect(result.content[0].text).toContain('Written');
    const read = await service.readFile('acme/test/overwrite.txt');
    expect(read.content[0].text).toBe('new');
  });

  it('read_file returns file content', async () => {
    await service.writeFile('acme/test/read.txt', 'content here');
    const result = await service.readFile('acme/test/read.txt');
    expect(result.content[0].text).toBe('content here');
  });

  it('read_file returns not-found message for missing file', async () => {
    const result = await service.readFile('acme/test/missing.txt');
    expect(result.content[0].text).toContain('not found');
  });

  it('delete_file soft-deletes and makes file invisible to list_files', async () => {
    await service.writeFile('acme/test/softdelete.txt', 'bye');
    const del = await service.deleteFile('acme/test/softdelete.txt');
    expect(del.content[0].text).toContain('Deleted');

    const list = await service.listFiles('acme/test/');
    const keys = (
      JSON.parse(list.content[0].text) as Array<{ key: string }>
    ).map((e) => e.key);
    expect(keys).not.toContain('acme/test/softdelete.txt');
  });

  it('restore_file brings back a soft-deleted file', async () => {
    await service.writeFile('acme/test/restore-me.txt', 'restore me');
    await service.deleteFile('acme/test/restore-me.txt');
    const restore = await service.restoreFile('acme/test/restore-me.txt');
    expect(restore.content[0].text).toContain('Restored');

    const read = await service.readFile('acme/test/restore-me.txt');
    expect(read.content[0].text).toBe('restore me');
  });

  it('restore_file returns error when no deleted file exists', async () => {
    const result = await service.restoreFile('acme/test/nope.txt');
    expect(result.content[0].text).toContain('No soft-deleted file found');
  });

  it('list_files returns files under prefix', async () => {
    await service.writeFile('acme/docs/a.md', '# A', true);
    await service.writeFile('acme/docs/b.md', '# B', true);
    const result = await service.listFiles('acme/docs/');
    const keys = (
      JSON.parse(result.content[0].text) as Array<{ key: string }>
    ).map((e) => e.key);
    expect(keys).toContain('acme/docs/a.md');
    expect(keys).toContain('acme/docs/b.md');
  });

  it('search_files filters by glob pattern', async () => {
    await service.writeFile('acme/search/report.md', '# R', true);
    await service.writeFile('acme/search/data.json', '{}', true);
    const result = await service.searchFiles('acme/search/', '*.md');
    const keys = (
      JSON.parse(result.content[0].text) as Array<{ key: string }>
    ).map((e) => e.key);
    expect(keys).toContain('acme/search/report.md');
    expect(keys).not.toContain('acme/search/data.json');
  });

  it('get_file_properties returns metadata for existing file', async () => {
    await service.writeFile('acme/test/props.txt', 'hello world');
    const result = await service.getFileProperties('acme/test/props.txt');
    const props = JSON.parse(result.content[0].text) as {
      exists: boolean;
      size: number;
    };
    expect(props.exists).toBe(true);
    expect(props.size).toBeGreaterThan(0);
  });

  it('get_file_properties returns exists:false for missing file', async () => {
    const result = await service.getFileProperties('acme/test/absent.txt');
    const props = JSON.parse(result.content[0].text) as { exists: boolean };
    expect(props.exists).toBe(false);
  });

  it('copy_file duplicates a file at the destination', async () => {
    await service.writeFile('acme/test/original.txt', 'to copy');
    const result = await service.copyFile(
      'acme/test/original.txt',
      'acme/test/copy.txt',
    );
    expect(result.content[0].text).toContain('Copied');
    const read = await service.readFile('acme/test/copy.txt');
    expect(read.content[0].text).toBe('to copy');
    // Original still there
    const orig = await service.readFile('acme/test/original.txt');
    expect(orig.content[0].text).toBe('to copy');
  });

  it('move_file moves the file and removes the original', async () => {
    await service.writeFile('acme/test/tomove.txt', 'moving');
    const result = await service.moveFile(
      'acme/test/tomove.txt',
      'acme/test/moved.txt',
    );
    expect(result.content[0].text).toContain('Moved');
    const dest = await service.readFile('acme/test/moved.txt');
    expect(dest.content[0].text).toBe('moving');
    const orig = await service.readFile('acme/test/tomove.txt');
    expect(orig.content[0].text).toContain('not found');
  });

  it('get_file_summary parses JSON structure', async () => {
    await service.writeFile(
      'acme/test/data.json',
      JSON.stringify({ name: 'Alice', age: 30 }),
      true,
    );
    const result = await service.getFileSummary('acme/test/data.json');
    const summary = JSON.parse(result.content[0].text) as {
      format: string;
      keys: string[];
    };
    expect(summary.format).toBe('json-object');
    expect(summary.keys).toContain('name');
  });

  it('get_file_summary extracts markdown headings', async () => {
    await service.writeFile(
      'acme/test/doc.md',
      '# Title\n## Section\nSome text.',
      true,
    );
    const result = await service.getFileSummary('acme/test/doc.md');
    const summary = JSON.parse(result.content[0].text) as {
      format: string;
      headings: Array<{ level: number; text: string }>;
    };
    expect(summary.format).toBe('markdown');
    expect(summary.headings[0].text).toBe('Title');
    expect(summary.headings[1].level).toBe(2);
  });

  it('path traversal is rejected', async () => {
    const result = await service.writeFile('acme/../secret.txt', 'evil');
    expect(result.content[0].text).toContain('Invalid');
  });

  it('writing to _deleted/ prefix is rejected', async () => {
    const result = await service.writeFile('_deleted/acme/file.txt', 'evil');
    expect(result.content[0].text).toContain('Invalid');
  });
});
