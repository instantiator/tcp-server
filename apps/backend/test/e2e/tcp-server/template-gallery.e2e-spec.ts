import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TcpCompany, TemplateSource } from '@tcp/shared';
import { strFromU8, unzipSync } from 'fflate';
import request from 'supertest';
import { App } from 'supertest/types';
import { In, Repository } from 'typeorm';
import { AppModule } from '../../../apps/tcp-server/src/app.module';
import { makeTestJwt } from '../helpers/test-jwt';

const RUN = Date.now();
const jwt = makeTestJwt();
// Named in `.env.testing`'s TCP_ADMIN_IDENTIFIERS.
const admin = makeTestJwt({ sub: 'e2e-admin' });

/** Writes a one-role template folder called `name` into `dir`. */
async function writeTemplate(dir: string, name: string, slug: string) {
  await mkdir(path.join(dir, name, 'roles', 'helper'), { recursive: true });
  await writeFile(
    path.join(dir, name, 'company.json'),
    JSON.stringify({
      formatVersion: 1,
      slug,
      name: `Gallery ${name}`,
      description: `The ${name} template`,
      plannerRole: 'helper',
    }),
  );
  await writeFile(
    path.join(dir, name, 'roles', 'helper', 'role.json'),
    JSON.stringify({ name: 'Helper', description: 'Helps' }),
  );
}

describe('Template gallery (e2e)', () => {
  let app: INestApplication<App>;
  let companyRepo: Repository<TcpCompany>;
  let sourceRepo: Repository<TemplateSource>;
  let builtinDir: string;
  let configDir: string;
  const slug = `gallery-import-${RUN}`;

  beforeAll(async () => {
    builtinDir = await mkdtemp(path.join(tmpdir(), 'tcp-builtin-'));
    configDir = await mkdtemp(path.join(tmpdir(), 'tcp-config-'));
    await writeTemplate(builtinDir, 'starter', slug);
    await writeTemplate(configDir, 'extra', `gallery-extra-${RUN}`);
    await mkdir(path.join(configDir, 'broken'));
    await writeFile(path.join(configDir, 'broken', 'company.json'), '{}');
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    // Stubbed before init, so the boot sync of configured sources sees them.
    const config = module.get(ConfigService);
    const get = config.get.bind(config);
    jest
      .spyOn(config, 'get')
      .mockImplementation((key: string) =>
        key === 'TEMPLATES_DIR'
          ? builtinDir
          : key === 'TEMPLATE_SOURCES'
            ? `dir:${configDir}`
            : get(key),
      );
    app = module.createNestApplication();
    // Listening, not just init() — see agent.e2e-spec.ts for why.
    await app.listen(0);
    companyRepo = module.get(getRepositoryToken(TcpCompany));
    sourceRepo = module.get(getRepositoryToken(TemplateSource));
  });

  afterAll(async () => {
    await companyRepo.delete({ slug: In([slug]) });
    await sourceRepo.delete({ location: `dir:${configDir}` });
    await app.close();
    await rm(builtinDir, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  });

  const get = (url: string, token = jwt) =>
    request(app.getHttpServer())
      .get(url)
      .set('Authorization', `Bearer ${token}`);

  it('lists templates from the built-in and configured sources, warning about a broken one', async () => {
    const res = await get('/api/template').expect(200);
    const names = (res.body as { sourceId: string; name: string }[]).map(
      (t) => `${t.sourceId === 'builtin' ? 'builtin' : 'config'}/${t.name}`,
    );
    expect(names).toEqual(['builtin/starter', 'config/extra']);
    const warnings = (
      JSON.parse(res.headers['x-tcp-warnings']) as string[]
    ).map(decodeURIComponent);
    expect(warnings).toEqual([expect.stringMatching(/broken/)]);
  });

  it('downloads a template as a zip', async () => {
    const res = await get('/api/template/builtin/starter')
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const files = unzipSync(new Uint8Array(res.body as Buffer));
    expect(JSON.parse(strFromU8(files['company.json']))).toMatchObject({
      slug,
    });
    await get('/api/template/builtin/nope').expect(404);
  });

  it('previews and imports a gallery template by name', async () => {
    const preview = await request(app.getHttpServer())
      .post('/api/company/import/preview')
      .set('Authorization', `Bearer ${jwt}`)
      .field('template', 'builtin/starter')
      .expect(200);
    expect((preview.body as { company: { slug: string } }).company.slug).toBe(
      slug,
    );
    const imported = await request(app.getHttpServer())
      .post('/api/company/import')
      .set('Authorization', `Bearer ${jwt}`)
      .field('template', 'builtin/starter')
      .expect(201);
    expect((imported.body as TcpCompany).slug).toBe(slug);
  });

  describe('sources', () => {
    it('lists the built-in source first, then the configured one', async () => {
      const res = await get('/api/template-source').expect(200);
      expect(
        (res.body as { id: string; origin: string; location: string }[]).map(
          (s) => [s.id === 'builtin' ? 'builtin' : 'row', s.origin, s.location],
        ),
      ).toEqual([
        ['builtin', 'builtin', `dir:${builtinDir}`],
        ['row', 'config', `dir:${configDir}`],
      ]);
    });

    it('lets only an administrator add and remove a GitHub source', async () => {
      const body = { name: 'Acme', repo: 'acme/templates', path: 'packs' };
      await request(app.getHttpServer())
        .post('/api/template-source')
        .set('Authorization', `Bearer ${jwt}`)
        .send(body)
        .expect(403);
      const added = await request(app.getHttpServer())
        .post('/api/template-source')
        .set('Authorization', `Bearer ${admin}`)
        .send(body)
        .expect(201);
      const source = added.body as { id: string; location: string };
      expect(source.location).toBe('github:acme/templates/packs#main');
      await request(app.getHttpServer())
        .delete(`/api/template-source/${source.id}`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(403);
      await request(app.getHttpServer())
        .delete(`/api/template-source/${source.id}`)
        .set('Authorization', `Bearer ${admin}`)
        .expect(204);
    });

    it('refuses a repository that is not owner/repo', async () => {
      await request(app.getHttpServer())
        .post('/api/template-source')
        .set('Authorization', `Bearer ${admin}`)
        .send({ name: 'Bad', repo: 'https://evil.example/x' })
        .expect(400);
    });

    it('refuses to remove the built-in or a configured source', async () => {
      const config = await sourceRepo.findOneByOrFail({
        location: `dir:${configDir}`,
      });
      for (const id of ['builtin', config.id]) {
        await request(app.getHttpServer())
          .delete(`/api/template-source/${id}`)
          .set('Authorization', `Bearer ${admin}`)
          .expect(400);
      }
    });
  });
});
