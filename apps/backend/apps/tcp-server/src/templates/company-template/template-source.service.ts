import { readdir, readFile, stat } from 'fs/promises';
import * as path from 'path';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { TemplateSource } from '@tcp/shared';
import { In, Repository } from 'typeorm';
import { MAX_UPLOAD_BYTES } from '../../api/upload-limit';
import { parseTemplate } from './format';
import {
  configuredLocations,
  githubLocation,
  parseLocation,
  SourceLocation,
} from './source-location';
import { readZip, TEMPLATE_ZIP_LIMITS, TemplateFiles } from './zip';

/** The id of the templates shipped with the server. */
export const BUILTIN_SOURCE_ID = 'builtin';

/** How long a GitHub source's download is reused. */
const GITHUB_CACHE_MS = 10 * 60 * 1000;

const GITHUB_TIMEOUT_MS = 30_000;

/** A gallery source as the API shows it. */
export interface TemplateSourceView {
  id: string;
  name: string;
  location: string;
  origin: 'builtin' | 'config' | 'user';
}

/** One template in the gallery. */
export interface GalleryTemplate {
  sourceId: string;
  sourceName: string;
  /** Its folder or zip name within the source; used to fetch it. */
  name: string;
  title: string;
  description: string;
  roles: number;
  documents: number;
}

/**
 * The template gallery's sources: the built-in templates, directories, and
 * public GitHub repositories. Sources set in `TEMPLATE_SOURCES` are kept in
 * step with the database at boot; administrators add and remove the rest.
 */
@Injectable()
export class TemplateSourceService implements OnModuleInit {
  private readonly logger = new Logger(TemplateSourceService.name);
  private readonly githubCache = new Map<
    string,
    { at: number; templates: Map<string, TemplateFiles> }
  >();

  constructor(
    @InjectRepository(TemplateSource)
    private readonly repo: Repository<TemplateSource>,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.syncConfigured();
  }

  /**
   * Makes the `config` rows match `TEMPLATE_SOURCES`: adds new ones, removes
   * ones no longer set, and claims a matching row an administrator added.
   * An unreadable entry is logged and skipped rather than stopping the boot.
   */
  async syncConfigured(): Promise<void> {
    const wanted = configuredLocations(
      this.config.get<string>('TEMPLATE_SOURCES') ?? '',
    ).filter((location) => {
      try {
        parseLocation(location);
        return true;
      } catch (err) {
        this.logger.warn(
          `Ignoring TEMPLATE_SOURCES entry: ${(err as Error).message}`,
        );
        return false;
      }
    });
    const stale = await this.repo.findBy({ origin: 'config' });
    const gone = stale.filter((s) => !wanted.includes(s.location));
    if (gone.length > 0) {
      await this.repo.delete({ id: In(gone.map((s) => s.id)) });
    }
    for (const location of wanted) {
      const existing = await this.repo.findOneBy({ location });
      if (existing) {
        if (existing.origin !== 'config') {
          await this.repo.update(existing.id, { origin: 'config' });
        }
      } else {
        await this.repo.save(
          this.repo.create({
            location,
            name: defaultName(parseLocation(location)),
            origin: 'config',
          }),
        );
      }
    }
  }

  /** Every source, the built-in one first. */
  async list(): Promise<TemplateSourceView[]> {
    const rows = await this.repo.find({ order: { createdAt: 'ASC' } });
    return [this.builtin(), ...rows.map(toView)];
  }

  /** Adds a GitHub repository as a source. */
  async addGithub(
    name: string,
    repo: string,
    ref?: string,
    subpath?: string,
  ): Promise<TemplateSourceView> {
    const location = githubLocation(repo, subpath, ref);
    if (await this.repo.findOneBy({ location })) {
      throw new ConflictException(`That source is already listed.`);
    }
    return toView(
      await this.repo.save(
        this.repo.create({ name, location, origin: 'user' }),
      ),
    );
  }

  /** Removes a source an administrator added. */
  async remove(id: string): Promise<void> {
    if (id === BUILTIN_SOURCE_ID) {
      throw new BadRequestException('The built-in templates can’t be removed.');
    }
    const row = await this.repo.findOneBy({ id: id as TemplateSource['id'] });
    if (!row) throw new NotFoundException(`No template source ${id}.`);
    if (row.origin === 'config') {
      throw new BadRequestException(
        'This source is set in the server’s TEMPLATE_SOURCES; remove it there.',
      );
    }
    this.githubCache.delete(row.location);
    await this.repo.delete(row.id);
  }

  /**
   * Every template from every source. A source that can't be read, or a
   * template that doesn't parse, becomes a warning rather than failing the
   * whole gallery.
   */
  async gallery(): Promise<{
    templates: GalleryTemplate[];
    warnings: string[];
  }> {
    const templates: GalleryTemplate[] = [];
    const warnings: string[] = [];
    for (const source of await this.list()) {
      let found: Map<string, TemplateFiles>;
      try {
        found = await this.read(source);
      } catch (err) {
        warnings.push(`${source.name}: ${(err as Error).message}`);
        continue;
      }
      for (const [name, files] of found) {
        try {
          const { template: t } = parseTemplate(files);
          templates.push({
            sourceId: source.id,
            sourceName: source.name,
            name,
            title: t.name,
            description: t.description,
            roles: t.roles.length,
            documents:
              t.documents.length +
              t.roles.reduce((n, r) => n + r.documents.length, 0),
          });
        } catch (err) {
          const first = (err as Error).message.split('\n')[0];
          warnings.push(`${source.name}: ${name}: ${first}`);
        }
      }
    }
    return { templates, warnings };
  }

  /** One template's files, as found in its source. */
  async templateFiles(sourceId: string, name: string): Promise<TemplateFiles> {
    const source = (await this.list()).find((s) => s.id === sourceId);
    const files = source ? (await this.read(source)).get(name) : undefined;
    if (!files) {
      throw new NotFoundException(`No template ${sourceId}/${name}.`);
    }
    return files;
  }

  private builtin(): TemplateSourceView {
    const dir = path.resolve(
      this.config.get<string>('TEMPLATES_DIR') ?? 'templates',
    );
    return {
      id: BUILTIN_SOURCE_ID,
      name: 'Built in',
      location: `dir:${dir}`,
      origin: 'builtin',
    };
  }

  /** The templates in a source, by name. */
  private read(
    source: TemplateSourceView,
  ): Promise<Map<string, TemplateFiles>> {
    const location = parseLocation(source.location);
    return location.kind === 'directory'
      ? readDirectory(location.path)
      : this.readGithub(source.location, location);
  }

  private async readGithub(
    key: string,
    loc: Extract<SourceLocation, { kind: 'github' }>,
  ): Promise<Map<string, TemplateFiles>> {
    const cached = this.githubCache.get(key);
    if (cached && Date.now() - cached.at < GITHUB_CACHE_MS) {
      return cached.templates;
    }
    // Every part of this URL was checked by parseLocation, and the host is
    // fixed, so a source can't point the server anywhere else.
    const url = `https://codeload.github.com/${loc.owner}/${loc.repo}/zip/${loc.ref}`;
    const res = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(
        `GitHub answered ${res.status} for ${loc.owner}/${loc.repo}#${loc.ref}`,
      );
    }
    // ponytail: the whole repository is downloaded and must fit the upload
    // limit; read only the templates folder if larger repos are needed.
    const files = readZip(
      await readCapped(res, MAX_UPLOAD_BYTES),
      TEMPLATE_ZIP_LIMITS,
    );
    const templates = selectTemplates(files, loc.path, loc.repo);
    this.githubCache.set(key, { at: Date.now(), templates });
    return templates;
  }
}

/** A source's name when its setting gives none. */
function defaultName(loc: SourceLocation): string {
  return loc.kind === 'github'
    ? `${loc.owner}/${loc.repo}`
    : path.basename(loc.path);
}

function toView(row: TemplateSource): TemplateSourceView {
  return {
    id: row.id,
    name: row.name,
    location: row.location,
    origin: row.origin,
  };
}

/**
 * The templates under `subpath` in an unpacked repository: `subpath` itself
 * when it holds a `company.json`, otherwise each folder directly beneath it
 * that does.
 */
function selectTemplates(
  files: TemplateFiles,
  subpath: string,
  repo: string,
): Map<string, TemplateFiles> {
  const base = subpath ? `${subpath}/` : '';
  const under = (prefix: string): TemplateFiles =>
    new Map(
      [...files]
        .filter(([p]) => p.startsWith(prefix))
        .map(([p, d]) => [p.slice(prefix.length), d]),
    );
  if (files.has(`${base}company.json`)) {
    return new Map([[path.posix.basename(subpath) || repo, under(base)]]);
  }
  const names = new Set(
    [...files.keys()]
      .filter((p) => p.startsWith(base))
      .map((p) => p.slice(base.length).split('/'))
      .filter((parts) => parts.length === 2 && parts[1] === 'company.json')
      .map((parts) => parts[0]),
  );
  return new Map([...names].sort().map((n) => [n, under(`${base}${n}/`)]));
}

/**
 * The templates in a directory: each folder holding a `company.json`, and
 * each `.zip` file. Symbolic links are not followed, so a template can't
 * reach outside its folder.
 */
async function readDirectory(dir: string): Promise<Map<string, TemplateFiles>> {
  const out = new Map<string, TemplateFiles>();
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && (await isFile(path.join(full, 'company.json')))) {
      out.set(e.name, await readFolder(full));
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.zip')) {
      const zip = await readFile(full);
      out.set(
        path.basename(e.name, path.extname(e.name)),
        readZip(new Uint8Array(zip), TEMPLATE_ZIP_LIMITS),
      );
    }
  }
  return out;
}

/** Reads a template folder into memory, within the zip limits. */
async function readFolder(root: string): Promise<TemplateFiles> {
  const files: TemplateFiles = new Map();
  let total = 0;
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    const full = path.join(e.parentPath, e.name);
    total += (await stat(full)).size;
    if (
      files.size >= TEMPLATE_ZIP_LIMITS.maxEntries ||
      total > TEMPLATE_ZIP_LIMITS.maxUncompressedBytes
    ) {
      throw new Error(`${path.basename(root)} is too large to serve.`);
    }
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (path.posix.basename(rel) === '.DS_Store') continue;
    files.set(rel, new Uint8Array(await readFile(full)));
  }
  return files;
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Reads a response body, refusing one larger than `limit` bytes. */
async function readCapped(res: Response, limit: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error(`The repository download is larger than ${limit} bytes.`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
