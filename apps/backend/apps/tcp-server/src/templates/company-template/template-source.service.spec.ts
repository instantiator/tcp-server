import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { TemplateSource } from '@tcp/shared';
import { strToU8, zipSync } from 'fflate';
import { Test } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TemplateSourceService } from './template-source.service';

const COMPANY = (slug: string) =>
  JSON.stringify({
    formatVersion: 1,
    slug,
    name: slug.toUpperCase(),
    description: `The ${slug} template`,
  });

type SourceRow = Pick<TemplateSource, 'name' | 'location' | 'origin'>;

/** A service over a fresh in-memory database holding `rows`. */
async function setup(
  settings: Record<string, string>,
  rows: SourceRow[] = [],
): Promise<{
  service: TemplateSourceService;
  repo: Repository<TemplateSource>;
  close: () => Promise<void>;
}> {
  const module = await Test.createTestingModule({
    imports: [
      TypeOrmModule.forRoot({
        type: 'better-sqlite3',
        database: ':memory:',
        entities: [TemplateSource],
        synchronize: true,
      }),
      TypeOrmModule.forFeature([TemplateSource]),
    ],
  }).compile();
  const repo = module.get<Repository<TemplateSource>>(
    getRepositoryToken(TemplateSource),
  );
  await repo.save(rows.map((r) => repo.create(r)));
  return {
    service: new TemplateSourceService(repo, new ConfigService(settings)),
    repo,
    close: () => module.close(),
  };
}

describe('TemplateSourceService', () => {
  let dir: string;
  let close: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'tcp-templates-'));
  });

  afterEach(async () => {
    await close?.();
    close = undefined;
    await rm(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  /** {@link setup}, closed after the test. */
  async function make(
    settings: Record<string, string>,
    rows: SourceRow[] = [],
  ) {
    const made = await setup(settings, rows);
    close = made.close;
    return made;
  }

  describe('syncConfigured', () => {
    it('adds new config sources, removes stale ones and claims user rows', async () => {
      const { service, repo } = await make(
        { TEMPLATE_SOURCES: 'github:acme/t, dir:/srv/shared, nonsense' },
        [
          { name: 'old', location: 'github:old/gone#main', origin: 'config' },
          { name: 'mine', location: 'dir:/srv/shared', origin: 'user' },
        ],
      );
      await service.syncConfigured();
      const rows = await repo.find();
      expect(rows.map((r) => [r.location, r.origin, r.name]).sort()).toEqual([
        ['dir:/srv/shared', 'config', 'mine'],
        ['github:acme/t', 'config', 'acme/t'],
      ]);
    });
  });

  describe('list and remove', () => {
    it('lists the built-in source first and refuses to remove it or a config source', async () => {
      const { service, repo } = await make({ TEMPLATES_DIR: dir }, [
        { name: 'c', location: 'dir:/c', origin: 'config' },
      ]);
      const sources = await service.list();
      expect(sources[0]).toEqual({
        id: 'builtin',
        name: 'Built in',
        location: `dir:${dir}`,
        origin: 'builtin',
      });
      const config = await repo.findOneByOrFail({ location: 'dir:/c' });
      await expect(service.remove('builtin')).rejects.toThrow(/built-in/);
      await expect(service.remove(config.id)).rejects.toThrow(
        /TEMPLATE_SOURCES/,
      );
    });

    it('adds and removes a GitHub source, refusing a duplicate', async () => {
      const { service, repo } = await make({});
      const added = await service.addGithub('A', 'acme/t');
      await expect(
        service.addGithub('B', 'acme/t', 'main', ''),
      ).rejects.toThrow(/already listed/);
      await service.remove(added.id);
      expect(await repo.count()).toBe(0);
    });
  });

  describe('a directory source', () => {
    it('serves template folders and zips, and warns about a broken one', async () => {
      await mkdir(path.join(dir, 'alpha', 'roles', 'a'), { recursive: true });
      await writeFile(
        path.join(dir, 'alpha', 'company.json'),
        COMPANY('alpha'),
      );
      await writeFile(
        path.join(dir, 'alpha', 'roles', 'a', 'role.json'),
        JSON.stringify({ name: 'A', description: 'a' }),
      );
      await writeFile(
        path.join(dir, 'beta.zip'),
        zipSync({ 'beta/company.json': strToU8(COMPANY('beta')) }),
      );
      await mkdir(path.join(dir, 'broken'));
      await writeFile(path.join(dir, 'broken', 'company.json'), '{');
      await mkdir(path.join(dir, 'not-a-template'));

      const { service } = await make({ TEMPLATES_DIR: dir });
      const { templates, warnings } = await service.gallery();
      expect(templates.map((t) => [t.name, t.title, t.roles])).toEqual([
        ['alpha', 'ALPHA', 1],
        ['beta', 'BETA', 0],
      ]);
      expect(warnings).toEqual([
        expect.stringMatching(/^Built in: broken: The template has problems/),
      ]);
      const files = await service.templateFiles('builtin', 'alpha');
      expect([...files.keys()].sort()).toEqual([
        'company.json',
        'roles/a/role.json',
      ]);
      await expect(service.templateFiles('builtin', 'nope')).rejects.toThrow(
        /No template/,
      );
    });
  });

  describe('a GitHub source', () => {
    const repoZip = zipSync({
      't-main/README.md': strToU8('repo readme'),
      't-main/packs/one/company.json': strToU8(COMPANY('one')),
      't-main/packs/two/company.json': strToU8(COMPANY('two')),
    });

    async function githubService() {
      const { service } = await make({ TEMPLATES_DIR: dir }, [
        { name: 'Acme', location: 'github:acme/t/packs#main', origin: 'user' },
      ]);
      return service;
    }

    it('fetches from codeload without redirects, and caches the download', async () => {
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(repoZip));
      const service = await githubService();
      const first = await service.gallery();
      await service.gallery();
      expect(first.templates.map((t) => t.name)).toEqual(['one', 'two']);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://codeload.github.com/acme/t/zip/main',
        expect.objectContaining({ redirect: 'error' }),
      );
    });

    it('turns a failed download into a warning', async () => {
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response('gone', { status: 404 }));
      const { templates, warnings } = await (await githubService()).gallery();
      expect(templates).toEqual([]);
      expect(warnings).toEqual([
        expect.stringMatching(/^Acme: GitHub answered 404/),
      ]);
    });

    it('refuses a download larger than the upload limit', async () => {
      const huge = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(8 * 1024 * 1024));
        },
      });
      jest.spyOn(global, 'fetch').mockResolvedValue(new Response(huge));
      const { warnings } = await (await githubService()).gallery();
      expect(warnings).toEqual([expect.stringMatching(/larger than/)]);
    });
  });
});
