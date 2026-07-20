import { ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';

/**
 * Verifies that MinIO at {@link endpoint} is reachable, failing fast rather
 * than surfacing as a raw SDK error the first time a storage write happens.
 * `MinioStorageAdapter.ensureBucketExists()` only warns (and continues) on an
 * unreachable MinIO, so without this check a container that reports healthy
 * before its S3 API is actually ready lets every subsequent storage
 * operation fail with an unhandled 500 instead of a clear startup error.
 *
 * Scope: startup-time reachability only, same as {@link assertRedisReachable}.
 * Doesn't require the target bucket to exist — `ListBuckets` only confirms
 * the S3 API itself is answering; bucket creation is a separate concern.
 *
 * @throws Error if MinIO cannot be reached within {@link timeoutMs}.
 */
export async function assertMinioReachable(
  endpoint: string,
  accessKeyId: string,
  secretAccessKey: string,
  timeoutMs = 5000,
): Promise<void> {
  const client = new S3Client({
    endpoint,
    region: 'us-east-1', // MinIO requires a region string; value is ignored
    forcePathStyle: true, // Required for MinIO
    credentials: { accessKeyId, secretAccessKey },
    // Fail fast: no SDK-level retries, and a hard cap on connect/response time.
    maxAttempts: 1,
    requestHandler: { requestTimeout: timeoutMs, connectionTimeout: timeoutMs },
  });
  try {
    await client.send(new ListBucketsCommand({}));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `MinIO is not reachable at ${endpoint}: ${reason}. ` +
        'Check MINIO_ENDPOINT/MINIO_ACCESS_KEY/MINIO_SECRET_KEY and that MinIO is running before starting this service.',
    );
  } finally {
    client.destroy();
  }
}
