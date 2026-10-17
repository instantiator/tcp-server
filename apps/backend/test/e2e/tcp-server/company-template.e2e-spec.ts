import { CompanyUser, TcpCompany, TcpRole } from '@tcp/shared';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import request from 'supertest';
import { App } from 'supertest/types';
import { In, Repository } from 'typeorm';
import { AppModule } from '../../../apps/tcp-server/src/app.module';
import { DbService } from '../../../apps/tcp-server/src/db/db.service';
import { makeTestJwt } from '../helpers/test-jwt';

const RUN = Date.now();
const OPENAI = { provider: 'openai', model: 'gpt-4o-mini' };
const GUIDE =
  '---\ntitle: Guide\nlicense: CC-BY-4.0\nsource: https://example.org/guide\n---\n\nRead me.';

/** A two-role template zip at `slug`, with company and role knowledge. */
function templateZip(
  slug: string,
  extra: Record<string, Uint8Array> = {},
): Buffer {
  const json = (v: object) => strToU8(JSON.stringify(v));
  return Buffer.from(
    zipSync({
      [`${slug}/company.json`]: json({
        formatVersion: 1,
        slug,
        name: 'Template Co',
        description: 'From a template',
        timezone: 'Europe/London',
        plannerRole: 'planner',
        llmConfig: { ...OPENAI, apiKey: 'sk-should-never-travel' },
      }),
      [`${slug}/context.md`]: strToU8('We test templates.'),
      [`${slug}/knowledge/guide.md`]: strToU8(GUIDE),
      [`${slug}/roles/planner/role.json`]: json({
        name: 'Planner',
        description: 'Plans the work',
        llmConfig: OPENAI,
      }),
      [`${slug}/roles/planner/prompt.md`]: strToU8('Plan carefully.'),
      [`${slug}/roles/writer/role.json`]: json({
        name: 'Writer',
        description: 'Writes things',
      }),
      [`${slug}/roles/writer/knowledge/notes.txt`]: strToU8('Some notes.'),
      ...Object.fromEntries(
        Object.entries(extra).map(([p, d]) => [`${slug}/${p}`, d]),
      ),
    }),
  );
}

describe('Company templates (e2e)', () => {
  let app: INestApplication<App>;
  let module: TestingModule;
  let companyRepo: Repository<TcpCompany>;
  let roleRepo: Repository<TcpRole>;
  let companyUserRepo: Repository<CompanyUser>;
  const created: string[] = [];
  const jwt = makeTestJwt();

  const slug = (name: string) => {
    const s = `tpl-${name}-${RUN}`;
    created.push(s);
    return s;
  };

  const importZip = (zip: Buffer, options: object = {}, token = jwt) =>
    request(app.getHttpServer())
      .post('/api/company/import')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', zip, 'template.zip')
      .field('options', JSON.stringify(options));

  const exportZip = async (companyId: string, query = '') => {
    const res = await request(app.getHttpServer())
      .get(`/api/company/${companyId}/export${query}`)
      .set('Authorization', `Bearer ${jwt}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers['content-type']).toBe('application/zip');
    return unzipSync(new Uint8Array(res.body as Buffer));
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    // Listening, not just init() — see agent.e2e-spec.ts for why.
    await app.listen(0);
    companyRepo = module.get(getRepositoryToken(TcpCompany));
    roleRepo = module.get(getRepositoryToken(TcpRole));
    companyUserRepo = module.get(getRepositoryToken(CompanyUser));
  });

  afterAll(async () => {
    await companyRepo.delete({ slug: In(created) });
    await app.close();
  });

  describe('preview', () => {
    it('describes the template without a key, and creates nothing', async () => {
      const s = slug('preview');
      const res = await request(app.getHttpServer())
        .post('/api/company/import/preview')
        .set('Authorization', `Bearer ${jwt}`)
        .attach('file', templateZip(s), 'template.zip')
        .expect(200);
      const preview = res.body as {
        company: { slug: string; llmConfig: object };
        plannerRole: string;
        roles: { slug: string; documents: number }[];
        documents: { scope: string; name: string; license?: string }[];
        neededKeys: string[];
        slugTaken: boolean;
        warnings: string[];
      };
      expect(JSON.stringify(preview)).not.toContain('sk-');
      expect(preview.company).toMatchObject({ slug: s, llmConfig: OPENAI });
      expect(preview.plannerRole).toBe('planner');
      expect(preview.roles.map((r) => [r.slug, r.documents])).toEqual([
        ['planner', 0],
        ['writer', 1],
      ]);
      expect(preview.documents).toContainEqual({
        scope: 'shared',
        name: 'guide.md',
        license: 'CC-BY-4.0',
        source: 'https://example.org/guide',
      });
      expect(preview.neededKeys).toEqual(['OpenAI']);
      expect(preview.slugTaken).toBe(false);
      expect(preview.warnings).toHaveLength(1);
      expect(await companyRepo.findOneBy({ slug: s })).toBeNull();
    });

    it('refuses a file that is not a template', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/company/import/preview')
        .set('Authorization', `Bearer ${jwt}`)
        .attach('file', Buffer.from('not a zip'), 'x.zip')
        .expect(400);
      expect(JSON.stringify(res.body)).toContain('not a readable zip');
    });
  });

  describe('import', () => {
    it('creates the company, its roles, planner and knowledge', async () => {
      const s = slug('import');
      const res = await importZip(templateZip(s)).expect(201);
      const company = res.body as TcpCompany;
      expect(company).toMatchObject({
        slug: s,
        companyContext: 'We test templates.',
        timezone: 'Europe/London',
        llmConfig: OPENAI,
      });
      const warnings = JSON.parse(res.headers['x-tcp-warnings']) as string[];
      expect(
        warnings.some((w) => decodeURIComponent(w).includes('API key')),
      ).toBe(true);

      const roles = await roleRepo.findBy({ companyId: company.id });
      const planner = roles.find((r) => r.slug === 'planner');
      expect(roles.map((r) => r.slug).sort()).toEqual(['planner', 'writer']);
      expect(planner?.rolePrompt).toBe('Plan carefully.');
      expect(company.plannerRoleId).toBe(planner?.id);

      const creator = await companyUserRepo.findOneBy({
        companyId: company.id,
        identifier: 'test-user',
      });
      expect(creator?.memberType).toBe('creator');

      const shared = await request(app.getHttpServer())
        .get(`/api/company/${company.id}/knowledge`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      expect((shared.body as { name: string }[]).map((d) => d.name)).toEqual([
        'guide.md',
      ]);
      const writer = roles.find((r) => r.slug === 'writer');
      const writerDocs = await request(app.getHttpServer())
        .get(`/api/role/${writer?.id}/knowledge`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      expect(
        (writerDocs.body as { name: string }[]).map((d) => d.name),
      ).toEqual(['notes.md']);
    });

    it('applies the importer’s choices over the template', async () => {
      const s = slug('options');
      const res = await importZip(templateZip('ignored-slug'), {
        slug: s,
        name: 'Renamed',
        llmConfig: null,
        roleModels: { planner: false },
      }).expect(201);
      const company = res.body as TcpCompany;
      expect(company).toMatchObject({ slug: s, name: 'Renamed' });
      expect(company.llmConfig ?? null).toBeNull();
      const planner = await roleRepo.findOneBy({
        companyId: company.id,
        slug: 'planner',
      });
      expect(planner?.llmConfig ?? null).toBeNull();
    });

    it('refuses roleModels naming a role the template lacks', async () => {
      const s = slug('badrole');
      await importZip(templateZip(s), { roleModels: { boss: false } }).expect(
        400,
      );
      expect(await companyRepo.findOneBy({ slug: s })).toBeNull();
    });

    it('refuses a taken slug without replace, and lets a member replace', async () => {
      const s = slug('clash');
      const first = (await importZip(templateZip(s)).expect(201))
        .body as TcpCompany;
      await importZip(templateZip(s)).expect(409);
      await importZip(
        templateZip(s),
        { replace: true },
        makeTestJwt({ sub: 'someone-else' }),
      ).expect(403);
      const second = (
        await importZip(templateZip(s), { replace: true }).expect(201)
      ).body as TcpCompany;
      expect(second.id).not.toBe(first.id);
    });

    it('writes nothing when a knowledge document is invalid', async () => {
      const s = slug('badknowledge');
      const res = await importZip(
        templateZip(s, { 'knowledge/broken.md': strToU8('no front matter') }),
      ).expect(400);
      expect(JSON.stringify(res.body)).toContain('knowledge/broken.md');
      expect(await companyRepo.findOneBy({ slug: s })).toBeNull();
    });

    it('deletes the new company when a later write fails', async () => {
      const s = slug('rollback');
      const setRole = jest
        .spyOn(module.get(DbService), 'setRole')
        .mockRejectedValueOnce(new Error('role write failed'));
      try {
        await importZip(templateZip(s)).expect(500);
      } finally {
        setRole.mockRestore();
      }
      expect(await companyRepo.findOneBy({ slug: s })).toBeNull();
    });
  });

  describe('export', () => {
    let company: TcpCompany;

    beforeAll(async () => {
      company = (await importZip(templateZip(slug('export'))).expect(201))
        .body as TcpCompany;
      // A stored key must never leave in an export.
      await companyRepo.update(company.id, {
        llmConfig: { ...OPENAI, apiKey: 'sk-stored-secret' },
      });
    });

    it('includes models but never a key', async () => {
      const files = await exportZip(company.id);
      const all = Object.values(files)
        .map((f) => strFromU8(f))
        .join('\n');
      expect(all).not.toContain('sk-');
      const json = JSON.parse(strFromU8(files['company.json'])) as {
        llmConfig: object;
        plannerRole: string;
      };
      expect(json.llmConfig).toEqual(OPENAI);
      expect(json.plannerRole).toBe('planner');
      expect(strFromU8(files['LICENSES.md'])).toContain('CC-BY-4.0');
    });

    it('leaves out every model with models=false', async () => {
      const files = await exportZip(company.id, '?models=false');
      expect(strFromU8(files['company.json'])).not.toContain('llmConfig');
      expect(strFromU8(files['roles/planner/role.json'])).not.toContain(
        'llmConfig',
      );
    });

    it('round-trips: importing an export recreates the company', async () => {
      const files = await exportZip(company.id);
      const s = slug('roundtrip');
      const copy = (
        await importZip(Buffer.from(zipSync(files)), {
          slug: s,
        }).expect(201)
      ).body as TcpCompany;
      const roles = async (id: string) =>
        (await roleRepo.findBy({ companyId: id as TcpCompany['id'] }))
          .map((r) => [r.slug, r.name, r.rolePrompt ?? null])
          .sort();
      expect(await roles(copy.id)).toEqual(await roles(company.id));
      expect(copy.companyContext).toBe(company.companyContext);
      const planner = await roleRepo.findOneBy({
        companyId: copy.id,
        slug: 'planner',
      });
      expect(copy.plannerRoleId).toBe(planner?.id);
    });

    it('is refused to a non-member', async () => {
      await request(app.getHttpServer())
        .get(`/api/company/${company.id}/export`)
        .set('Authorization', `Bearer ${makeTestJwt({ sub: 'outsider' })}`)
        .expect(403);
    });
  });
});
