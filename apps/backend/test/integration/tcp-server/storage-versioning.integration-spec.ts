import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  HeadBucketCommand,
  LifecycleRule,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { TcpCompany, TcpRole } from '@tcp/shared';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { StorageVersioningService } from '../../../apps/tcp-server/src/storage/storage-versioning.service';
import { requireEnv } from '../../support/require-env';

/**
 * {@link StorageVersioningService} against real MinIO and PostgreSQL: boot
 * turns on versioning and writes the retention rules, and a company change
 * rewrites them. The image in use (`pgsty/silo`) must support both, which is
 * what this proves.
 * Run via: ./scripts/run-integration-tests.sh
 */
const ENDPOINT = requireEnv('MINIO_ENDPOINT');
const DATABASE_URL = requireEnv('DATABASE_URL');
const BUCKET = 'tcp-versioning-test';
const SLUGS = ['versioning-a', 'versioning-b'];
const ACCESS_KEY = process.env.MINIO_ACCESS_KEY ?? 'tcp-access-key';
const SECRET_KEY = process.env.MINIO_SECRET_KEY ?? 'tcp-secret-key';

/** Polls `read` until `done` holds, or fails after a few seconds. */
async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
): Promise<T> {
  for (let i = 0; i < 25; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('condition not met in time');
}

describe('StorageVersioningService (integration)', () => {
  let module: TestingModule;
  let service: StorageVersioningService;
  let companyRepo: Repository<TcpCompany>;
  let s3: S3Client;

  const rules = async (): Promise<LifecycleRule[]> =>
    (
      await s3.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: BUCKET }),
      )
    ).Rules ?? [];
  const daysFor = (all: LifecycleRule[], slug: string): number | undefined =>
    all.find((r) => r.ID === `company-${slug}`)?.NoncurrentVersionExpiration
      ?.NoncurrentDays;

  beforeAll(async () => {
    s3 = new S3Client({
      endpoint: ENDPOINT,
      region: 'us-east-1',
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
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
          entities: [TcpCompany, TcpRole],
        }),
        TypeOrmModule.forFeature([TcpCompany]),
      ],
      providers: [
        StorageVersioningService,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            MINIO_ENDPOINT: ENDPOINT,
            MINIO_ACCESS_KEY: ACCESS_KEY,
            MINIO_SECRET_KEY: SECRET_KEY,
            MINIO_BUCKET_PREFIX: BUCKET,
            STORAGE_VERSION_RETENTION_DAYS: '30',
          }),
        },
      ],
    }).compile();

    companyRepo = module.get(getRepositoryToken(TcpCompany));
    await companyRepo.delete({ slug: In(SLUGS) });
    await companyRepo.save([
      companyRepo.create({ slug: SLUGS[0], name: 'A', description: 'test' }),
      companyRepo.create({
        slug: SLUGS[1],
        name: 'B',
        description: 'test',
        versionRetentionDays: 400,
      }),
    ]);
    service = module.get(StorageVersioningService);
    await module.init();
  });

  afterAll(async () => {
    const versions = await s3.send(
      new ListObjectVersionsCommand({ Bucket: BUCKET }),
    );
    await Promise.all(
      [...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])].map(
        (v) =>
          s3.send(
            new DeleteObjectCommand({
              Bucket: BUCKET,
              Key: v.Key,
              VersionId: v.VersionId,
            }),
          ),
      ),
    );
    await companyRepo.delete({ slug: In(SLUGS) });
    await module.close();
    s3.destroy();
  });

  it('turns on versioning at boot, so an overwrite keeps the old version', async () => {
    const { Status } = await s3.send(
      new GetBucketVersioningCommand({ Bucket: BUCKET }),
    );
    expect(Status).toBe('Enabled');

    const key = `${SLUGS[0]}/resources/price-list.md`;
    await s3.send(
      new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: '1' }),
    );
    await s3.send(
      new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: '2' }),
    );
    const { Versions } = await s3.send(
      new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: key }),
    );
    expect(Versions).toHaveLength(2);
  });

  it('writes a rule per company at boot, with the default or its own days', async () => {
    const all = await rules();
    expect(all.find((r) => r.ID === 'soft-deleted')).toBeDefined();
    expect(daysFor(all, SLUGS[0])).toBe(30);
    expect(daysFor(all, SLUGS[1])).toBe(400);
  });

  it("rewrites the rules when a company's retention changes", async () => {
    const company = await companyRepo.findOneByOrFail({ slug: SLUGS[0] });
    await companyRepo.save({ ...company, versionRetentionDays: 7 });
    const all = await waitFor(rules, (r) => daysFor(r, SLUGS[0]) === 7);
    expect(daysFor(all, SLUGS[1])).toBe(400);
  });

  it('adds a rule for a new company', async () => {
    const slug = 'versioning-new';
    SLUGS.push(slug);
    await companyRepo.save(
      companyRepo.create({ slug, name: 'New', description: 'test' }),
    );
    await waitFor(rules, (r) => daysFor(r, slug) === 30);
  });

  it('ignores a company update that does not touch retention', async () => {
    const sync = jest.spyOn(service, 'syncLifecycle');
    const company = await companyRepo.findOneByOrFail({ slug: SLUGS[1] });
    await companyRepo.save({ ...company, description: 'changed' });
    await new Promise((r) => setTimeout(r, 1500));
    expect(sync).not.toHaveBeenCalled();
  });
});
