import { assertMinioReachable } from './minio-reachability';

const send = jest.fn();
const destroy = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send, destroy })),
  ListBucketsCommand: jest.fn(),
}));

describe('assertMinioReachable', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves when the client can list buckets', async () => {
    send.mockResolvedValue({ Buckets: [] });

    await expect(
      assertMinioReachable('http://localhost:9000', 'key', 'secret'),
    ).resolves.toBeUndefined();
    expect(destroy).toHaveBeenCalled();
  });

  it('throws an actionable error when the connection fails', async () => {
    send.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      assertMinioReachable('http://localhost:9000', 'key', 'secret'),
    ).rejects.toThrow(/MinIO is not reachable/);
    expect(destroy).toHaveBeenCalled();
  });
});
