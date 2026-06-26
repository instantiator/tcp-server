import {
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'stream';
import { MinioService } from './minio.service';

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

describe('MinioService', () => {
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
      const svc = new MinioService(makeConfig());
      await expect(svc.onModuleInit()).resolves.not.toThrow();
      expect(send).toHaveBeenCalledWith(expect.any(HeadBucketCommand));
    });

    it('creates the bucket when HeadBucket returns NoSuchBucket', async () => {
      const noSuch = Object.assign(new Error('not found'), {
        name: 'NoSuchBucket',
      });
      send.mockRejectedValueOnce(noSuch).mockResolvedValue({});
      const svc = new MinioService(makeConfig());
      await svc.onModuleInit();
      expect(send).toHaveBeenCalledTimes(2);
    });
  });

  describe('putKnowledgeFile', () => {
    it('calls PutObject with the correct key and returns it', async () => {
      send.mockResolvedValue({});
      const svc = new MinioService(makeConfig());
      const key = await svc.putKnowledgeFile(
        'acme',
        'analyst',
        'report.md',
        'content',
      );
      expect(key).toBe('acme/knowledge/analyst/report.md');
      expect(send).toHaveBeenCalledWith(expect.any(PutObjectCommand));
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
      const svc = new MinioService(makeConfig());
      const files = await svc.listKnowledgeFiles('acme', 'analyst');
      expect(files).toHaveLength(1);
      expect(files[0].name).toBe('report.md');
      expect(files[0].size).toBe(512);
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
      const svc = new MinioService(makeConfig());
      const files = await svc.listKnowledgeFiles('acme', 'analyst');
      expect(files).toHaveLength(2);
      expect(send).toHaveBeenCalledTimes(2);
    });
  });

  describe('getKnowledgeFile', () => {
    it('returns file content as a string', async () => {
      send.mockResolvedValue({ Body: makeReadable('hello world') });
      const svc = new MinioService(makeConfig());
      const content = await svc.getKnowledgeFile(
        'acme',
        'analyst',
        'report.md',
      );
      expect(content).toBe('hello world');
    });

    it('returns null when the object does not exist', async () => {
      const noKey = Object.assign(new Error('no key'), { name: 'NoSuchKey' });
      send.mockRejectedValue(noKey);
      const svc = new MinioService(makeConfig());
      const content = await svc.getKnowledgeFile(
        'acme',
        'analyst',
        'missing.md',
      );
      expect(content).toBeNull();
    });
  });

  describe('getByKey', () => {
    it('returns a stream and contentType for an existing key', async () => {
      const stream = makeReadable('binary');
      send.mockResolvedValue({ Body: stream, ContentType: 'text/plain' });
      const svc = new MinioService(makeConfig());
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
      const svc = new MinioService(makeConfig());
      const result = await svc.getByKey('acme/tasks/x/output/file.bin');
      expect(result!.contentType).toBe('application/octet-stream');
    });

    it('returns null for a missing key', async () => {
      const err = Object.assign(new Error('not found'), { name: 'NotFound' });
      send.mockRejectedValue(err);
      const svc = new MinioService(makeConfig());
      expect(await svc.getByKey('missing/key')).toBeNull();
    });

    it('rethrows unexpected errors', async () => {
      send.mockRejectedValue(new Error('connection refused'));
      const svc = new MinioService(makeConfig());
      await expect(svc.getByKey('some/key')).rejects.toThrow(
        'connection refused',
      );
    });
  });

  describe('putByKey', () => {
    it('sends PutObjectCommand and returns byte count', async () => {
      send.mockResolvedValue({});
      const svc = new MinioService(makeConfig());
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
      const svc = new MinioService(makeConfig());
      await svc.putByKey('a/b.png', Buffer.from('img'), 'image/png');
      expect(capturedInput?.ContentType).toBe('image/png');
      expect(capturedInput?.ContentLength).toBe(3);
    });
  });

  describe('listKnowledgeFiles bucket name', () => {
    it('uses the MINIO_BUCKET_PREFIX env var when set', async () => {
      send.mockResolvedValue({
        Contents: [],
        NextContinuationToken: undefined,
      });
      const svc = new MinioService(
        makeConfig({ MINIO_BUCKET_PREFIX: 'custom-bucket' }),
      );
      await svc.listKnowledgeFiles('acme', 'analyst');
      const [cmd] = send.mock.calls[0] as [ListObjectsV2Command];
      expect(cmd.input.Bucket).toBe('custom-bucket');
    });

    it('defaults to "lcp" when MINIO_BUCKET_PREFIX is not set', async () => {
      send.mockResolvedValue({
        Contents: [],
        NextContinuationToken: undefined,
      });
      const svc = new MinioService(makeConfig());
      await svc.listKnowledgeFiles('acme', 'analyst');
      const [cmd] = send.mock.calls[0] as [ListObjectsV2Command];
      expect(cmd.input.Bucket).toBe('lcp');
    });
  });
});
