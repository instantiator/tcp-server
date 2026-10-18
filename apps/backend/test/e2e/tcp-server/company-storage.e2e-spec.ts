import { CompanyUser, TcpCompany } from '@tcp/shared';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { unzipSync } from 'fflate';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../../apps/tcp-server/src/app.module';
import { makeTestJwt } from '../helpers/test-jwt';
import { seedMembership } from '../helpers/seed-membership';

/** A folder listing, as `GET …/storage/folder` returns it. */
interface Listing {
  path: string;
  writable: boolean;
  folders: { path: string; name: string; purpose: string | null }[];
  files: { path: string; name: string; size: number }[];
}

/** A version entry, as `GET …/storage/versions` returns it. */
interface Version {
  versionId: string;
  isLatest: boolean;
}

/**
 * e2e coverage for the storage browser's routes (002.05) against real MinIO:
 * the company boundary, the `resources/`-only write rule, name clashes,
 * downloads, zips, version history and restore, and folder delete.
 */
describe('CompanyStorageController (e2e)', () => {
  let app: INestApplication<App>;
  let companyRepo: Repository<TcpCompany>;
  let company: TcpCompany;
  const jwt = makeTestJwt();
  const base = () => `/api/company/${company.id}/storage`;
  const http = () => request(app.getHttpServer());

  /** Uploads `content` to `path`, returning the response. */
  const upload = (path: string, content: string, overwrite = false) =>
    http()
      .post(
        `${base()}/file?path=${encodeURIComponent(path)}${overwrite ? '&overwrite=true' : ''}`,
      )
      .set('Authorization', `Bearer ${jwt}`)
      .attach('file', Buffer.from(content), path.split('/').at(-1) ?? 'f');

  const list = async (path: string): Promise<Listing> => {
    const res = await http()
      .get(`${base()}/folder?path=${encodeURIComponent(path)}`)
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);
    return res.body as Listing;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.listen(0);
    companyRepo = moduleFixture.get(getRepositoryToken(TcpCompany));
    // A fresh slug each run: the bucket outlives the database, and old
    // versions would otherwise pile up under a reused one.
    company = await companyRepo.save(
      companyRepo.create({
        slug: `storage-browser-${Date.now()}`,
        name: 'Storage Browser Co',
        description: 'test',
      }),
    );
    await seedMembership(
      moduleFixture.get(getRepositoryToken(CompanyUser)),
      company.id,
    );
  });

  afterAll(async () => {
    await companyRepo.delete({ id: company.id });
    await app.close();
  });

  describe('listing', () => {
    beforeAll(async () => {
      await upload('resources/pricing/README.md', '\n# Price lists\n').expect(
        201,
      );
      await upload('resources/pricing/tea.md', '# Tea\n').expect(201);
    });

    it('shows resources/ at the root, read-only there', async () => {
      const root = await list('');
      expect(root.writable).toBe(false);
      expect(root.folders.map((f) => f.path)).toContain('resources/');
    });

    it("gives a resources subfolder its README's purpose", async () => {
      const resources = await list('resources/');
      expect(resources.writable).toBe(true);
      expect(resources.folders).toEqual([
        { path: 'resources/pricing/', name: 'pricing', purpose: 'Price lists' },
      ]);
    });

    it('lists files with their paths and sizes, by name', async () => {
      const pricing = await list('resources/pricing/');
      expect(pricing.files.map((f) => [f.path, f.size])).toEqual([
        ['resources/pricing/README.md', 15],
        ['resources/pricing/tea.md', 6],
      ]);
    });

    it('refuses a path that climbs out of the company folder', async () => {
      await http()
        .get(`${base()}/folder?path=${encodeURIComponent('../other/')}`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(400);
    });
  });

  describe('membership', () => {
    const outsider = makeTestJwt({ sub: 'outsider' });

    it.each([
      ['get', '/folder?path='],
      ['get', '/file?path=resources/x.md'],
      ['get', '/versions?path=resources/x.md'],
      ['post', '/zip'],
      ['post', '/restore'],
      ['delete', '?path=resources/x.md'],
    ] as const)('refuses a non-member: %s %s', async (method, route) => {
      await http()
        [method](`${base()}${route}`)
        .set('Authorization', `Bearer ${outsider}`)
        .expect(403);
    });

    it('refuses a non-member upload', async () => {
      await http()
        .post(`${base()}/file?path=resources/x.md`)
        .set('Authorization', `Bearer ${outsider}`)
        .attach('file', Buffer.from('x'), 'x.md')
        .expect(403);
    });
  });

  describe('uploads', () => {
    it('writes into resources/, not elsewhere', async () => {
      await upload('resources/up/a.txt', 'one').expect(201);
      await upload('tasks/t1/materials/a.txt', 'one').expect(403);
      await upload('knowledge/shared/a.md', '---\ntitle: A\n---\n').expect(403);
    });

    it('asks before replacing, then replaces with overwrite', async () => {
      await upload('resources/up/b.txt', 'one').expect(201);
      await upload('resources/up/b.txt', 'two').expect(409);
      const res = await upload('resources/up/b.txt', 'two', true).expect(201);
      expect(res.body).toEqual({ path: 'resources/up/b.txt', size: 3 });
    });

    it('downloads as an attachment the browser may not sniff', async () => {
      await upload('resources/up/c ü.txt', 'hello').expect(201);
      const res = await http()
        .get(
          `${base()}/file?path=${encodeURIComponent('resources/up/c ü.txt')}`,
        )
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      expect(res.text).toBe('hello');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-disposition']).toContain(
        "filename*=UTF-8''c%20%C3%BC.txt",
      );
    });

    it('404s for a missing file', async () => {
      await http()
        .get(`${base()}/file?path=resources/up/missing.txt`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(404);
    });
  });

  describe('zip', () => {
    beforeAll(async () => {
      await upload('resources/zip/a.txt', 'A').expect(201);
      await upload('resources/zip/sub/b.txt', 'B').expect(201);
    });

    it('zips a folder, naming entries relative to root', async () => {
      const res = await http()
        .post(`${base()}/zip`)
        .set('Authorization', `Bearer ${jwt}`)
        .send({ root: 'resources/', paths: ['resources/zip/'] })
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      const entries = unzipSync(new Uint8Array(res.body as Buffer));
      expect(Object.keys(entries).sort()).toEqual([
        'zip/a.txt',
        'zip/sub/b.txt',
      ]);
      expect(Buffer.from(entries['zip/sub/b.txt']).toString()).toBe('B');
    });

    it('refuses a path outside root', async () => {
      await http()
        .post(`${base()}/zip`)
        .set('Authorization', `Bearer ${jwt}`)
        .send({ root: 'resources/zip/', paths: ['resources/up/a.txt'] })
        .expect(400);
    });

    it('404s when nothing named exists', async () => {
      await http()
        .post(`${base()}/zip`)
        .set('Authorization', `Bearer ${jwt}`)
        .send({ root: '', paths: ['resources/nothing-here/'] })
        .expect(404);
    });
  });

  describe('versions and restore', () => {
    const path = 'resources/history/price.md';
    const versions = async (): Promise<Version[]> => {
      const res = await http()
        .get(`${base()}/versions?path=${encodeURIComponent(path)}`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      return res.body as Version[];
    };
    const read = async (): Promise<string> => {
      const res = await http()
        .get(`${base()}/file?path=${encodeURIComponent(path)}`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      return res.text;
    };

    beforeAll(async () => {
      await upload(path, '# Old\n').expect(201);
      await upload(path, '# New\n', true).expect(201);
    });

    it('lists both versions, newest first', async () => {
      const listed = await versions();
      expect(listed).toHaveLength(2);
      expect(listed.map((v) => v.isLatest)).toEqual([true, false]);
    });

    it('downloads an old version by id', async () => {
      const [, old] = await versions();
      const res = await http()
        .get(
          `${base()}/file?path=${encodeURIComponent(path)}&versionId=${encodeURIComponent(old.versionId)}`,
        )
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      expect(res.text).toBe('# Old\n');
    });

    it('restores an old version as a new current one', async () => {
      const [, old] = await versions();
      await http()
        .post(`${base()}/restore`)
        .set('Authorization', `Bearer ${jwt}`)
        .send({ path, versionId: old.versionId })
        .expect(201);
      expect(await read()).toBe('# Old\n');
      expect(await versions()).toHaveLength(3);
    });

    it('404s for an unknown version', async () => {
      await http()
        .post(`${base()}/restore`)
        .set('Authorization', `Bearer ${jwt}`)
        .send({ path, versionId: 'no-such-version' })
        .expect(404);
    });

    it('refuses to restore outside resources/', async () => {
      await http()
        .post(`${base()}/restore`)
        .set('Authorization', `Bearer ${jwt}`)
        .send({ path: 'knowledge/shared/a.md', versionId: 'v1' })
        .expect(403);
    });
  });

  describe('delete', () => {
    beforeAll(async () => {
      await upload('resources/del/one.txt', '1').expect(201);
      await upload('resources/del/folder/two.txt', '2').expect(201);
      await upload('resources/del/folder/deeper/three.txt', '3').expect(201);
    });

    const remove = (path: string) =>
      http()
        .delete(`${base()}?path=${encodeURIComponent(path)}`)
        .set('Authorization', `Bearer ${jwt}`);

    it('deletes a file', async () => {
      await remove('resources/del/one.txt').expect(204);
      const listing = await list('resources/del/');
      expect(listing.files).toEqual([]);
    });

    it('deletes every file under a folder', async () => {
      await remove('resources/del/folder/').expect(204);
      const listing = await list('resources/del/');
      expect(listing.folders).toEqual([]);
    });

    it('404s for nothing there', async () => {
      await remove('resources/del/gone.txt').expect(404);
      await remove('resources/del/empty/').expect(404);
    });

    it('keeps resources/ itself and everything outside it', async () => {
      await remove('resources/').expect(403);
      await remove('').expect(403);
      await remove('tasks/t1/').expect(403);
    });
  });
});
