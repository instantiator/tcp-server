import * as path from 'path';
import { BadRequestException } from '@nestjs/common';
import type { LlmConfig, McpServerToggles } from '@tcp/shared';
import { parseFrontMatter } from '@tcp/shared';
import { plainToInstance, Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateNested,
  ValidationError,
  validateSync,
} from 'class-validator';
import { IsMcpServerToggles } from '../../api/dto/is-mcp-server-toggles.validator';
import {
  IsIanaTimeZone,
  normalizeIanaTimeZone,
} from '../../api/dto/is-valid-timezone.validator';
import { LlmConfigDto } from '../../api/dto/llm-config.dto';
import { SUPPORTED_EXTENSIONS } from '../../api/knowledge-conversion';
import { SHARED_KNOWLEDGE_ROLE_SLUG } from '../../storage/storage-keys';
import type { TemplateFiles } from './zip';

/** The newest template format this server reads and the one it writes. */
export const TEMPLATE_FORMAT_VERSION = 1;

/** Lower-case words joined by hyphens: the shape of company and role slugs. */
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const SLUG_MESSAGE =
  '$property must be lower-case letters and digits joined by hyphens';

/** `company.json`: the format version and the company's own fields. */
class TemplateCompanyJson {
  @IsInt()
  @Min(1)
  formatVersion!: number;

  @Matches(SLUG, { message: SLUG_MESSAGE })
  slug!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsNotEmpty()
  description!: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizeIanaTimeZone(value))
  @IsIanaTimeZone()
  timezone?: string | null;

  @IsOptional()
  @IsString()
  systemPromptTemplate?: string | null;

  @IsOptional()
  @Matches(SLUG, { message: SLUG_MESSAGE })
  plannerRole?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => LlmConfigDto)
  llmConfig?: LlmConfigDto | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => LlmConfigDto)
  embeddingConfig?: LlmConfigDto | null;

  @IsOptional()
  @IsMcpServerToggles()
  mcpServerToggles?: McpServerToggles | null;
}

/** `roles/<slug>/role.json`: one role's fields. Its slug is the folder name. */
class TemplateRoleJson {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsNotEmpty()
  description!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => LlmConfigDto)
  llmConfig?: LlmConfigDto | null;

  @IsOptional()
  @IsString()
  systemPromptTemplate?: string | null;

  @IsOptional()
  @IsMcpServerToggles()
  mcpServerToggles?: McpServerToggles | null;
}

/** A knowledge file as it sits in the template, before any conversion. */
export interface TemplateDocument {
  name: string;
  data: Uint8Array;
}

/** One role in a {@link CompanyTemplate}. */
export interface TemplateRole {
  slug: string;
  name: string;
  description: string;
  rolePrompt: string | null;
  llmConfig: LlmConfig | null;
  systemPromptTemplate: string | null;
  mcpServerToggles: McpServerToggles | null;
  documents: TemplateDocument[];
}

/** A company template, read from or ready to write as {@link TemplateFiles}. */
export interface CompanyTemplate {
  slug: string;
  name: string;
  description: string;
  timezone: string | null;
  companyContext: string | null;
  systemPromptTemplate: string | null;
  plannerRole: string | null;
  llmConfig: LlmConfig | null;
  embeddingConfig: LlmConfig | null;
  mcpServerToggles: McpServerToggles | null;
  /** Company-wide (shared) knowledge. */
  documents: TemplateDocument[];
  roles: TemplateRole[];
}

/** A parsed template plus anything the reader should be told about it. */
export interface ParsedTemplate {
  template: CompanyTemplate;
  warnings: string[];
}

const ROLE_FILE = /^roles\/([^/]+)\/(role\.json|prompt\.md)$/;
const ROLE_DOC = /^roles\/([^/]+)\/knowledge\/([^/]+)$/;
const SHARED_DOC = /^knowledge\/([^/]+)$/;
const TOP_LEVEL_MD = /^[^/]+\.md$/;

/**
 * Reads a template's files into a {@link CompanyTemplate}.
 *
 * Every problem is collected and reported at once, each prefixed with the
 * path it was found in, so an author can fix a template in one pass. Unknown
 * keys and files outside the layout are refused rather than ignored, so a
 * typo can't silently drop part of a template. An `apiKey` is dropped with a
 * warning: templates are shared, and must never carry one.
 *
 * @throws {@link BadRequestException} listing every problem found.
 */
export function parseTemplate(files: TemplateFiles): ParsedTemplate {
  const errors: string[] = [];
  const warnings: string[] = [];
  const roleFiles = new Map<string, Map<string, Uint8Array>>();
  const roleDocs = new Map<string, TemplateDocument[]>();
  const sharedDocs: TemplateDocument[] = [];

  for (const [p, data] of files) {
    if (path.posix.basename(p) === '.gitkeep') continue;
    let m: RegExpMatchArray | null;
    if (p === 'company.json' || TOP_LEVEL_MD.test(p)) continue;
    if ((m = p.match(ROLE_FILE))) {
      mapOf(roleFiles, m[1]).set(m[2], data);
    } else if ((m = p.match(ROLE_DOC))) {
      if (checkDocName(p, m[2], errors)) {
        listOf(roleDocs, m[1]).push({ name: m[2], data });
      }
      mapOf(roleFiles, m[1]);
    } else if ((m = p.match(SHARED_DOC))) {
      if (checkDocName(p, m[1], errors)) {
        sharedDocs.push({ name: m[1], data });
      }
    } else {
      errors.push(`${p}: not part of the template layout`);
    }
  }

  const companyData = files.get('company.json');
  const company = companyData
    ? readJson(TemplateCompanyJson, 'company.json', companyData, errors)
    : (errors.unshift('company.json: missing'), null);
  if (company && company.formatVersion > TEMPLATE_FORMAT_VERSION) {
    throw new BadRequestException(
      `This template uses format version ${company.formatVersion}, made by a ` +
        `newer version of TCP. This server reads version ${TEMPLATE_FORMAT_VERSION}.`,
    );
  }

  const roles: TemplateRole[] = [];
  for (const [slug, parts] of [...roleFiles].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const where = `roles/${slug}`;
    if (!SLUG.test(slug) || slug === SHARED_KNOWLEDGE_ROLE_SLUG) {
      errors.push(
        `${where}: a role folder must be a slug (lower-case letters and ` +
          `digits joined by hyphens), and not "${SHARED_KNOWLEDGE_ROLE_SLUG}"`,
      );
      continue;
    }
    const roleData = parts.get('role.json');
    if (!roleData) {
      errors.push(`${where}/role.json: missing`);
      continue;
    }
    const role = readJson(
      TemplateRoleJson,
      `${where}/role.json`,
      roleData,
      errors,
    );
    if (!role) continue;
    const prompt = parts.get('prompt.md');
    roles.push({
      slug,
      name: role.name,
      description: role.description,
      rolePrompt: prompt
        ? readText(`${where}/prompt.md`, prompt, errors)
        : null,
      llmConfig: keyless(role.llmConfig, `${where}/role.json`, warnings),
      systemPromptTemplate: role.systemPromptTemplate ?? null,
      mcpServerToggles: role.mcpServerToggles ?? null,
      documents: roleDocs.get(slug) ?? [],
    });
  }

  if (
    company?.plannerRole &&
    !roles.some((r) => r.slug === company.plannerRole)
  ) {
    errors.push(
      `company.json: plannerRole "${company.plannerRole}" has no roles/${company.plannerRole}/ folder`,
    );
  }

  const contextData = files.get('context.md');
  const companyContext = contextData
    ? readText('context.md', contextData, errors)
    : null;

  if (errors.length > 0 || !company) {
    throw new BadRequestException(
      `The template has problems:\n- ${errors.join('\n- ')}`,
    );
  }

  return {
    template: {
      slug: company.slug,
      name: company.name,
      description: company.description,
      timezone: company.timezone ?? null,
      companyContext,
      systemPromptTemplate: company.systemPromptTemplate ?? null,
      plannerRole: company.plannerRole ?? null,
      llmConfig: keyless(company.llmConfig, 'company.json', warnings),
      embeddingConfig: keyless(
        company.embeddingConfig,
        'company.json',
        warnings,
      ),
      mcpServerToggles: company.mcpServerToggles ?? null,
      documents: sharedDocs,
      roles,
    },
    warnings,
  };
}

/**
 * Lays a {@link CompanyTemplate} out as files. Empty and `null` fields are
 * left out, so a template carries only what it sets. `LICENSES.md` lists the
 * licence of every Markdown document whose front matter names one, so a
 * shared template keeps its attributions.
 */
export function writeTemplate(t: CompanyTemplate): TemplateFiles {
  const files: TemplateFiles = new Map();
  const enc = new TextEncoder();
  const json = (v: object) =>
    enc.encode(`${JSON.stringify(withoutEmpty(v), null, 2)}\n`);

  files.set(
    'company.json',
    json({
      formatVersion: TEMPLATE_FORMAT_VERSION,
      slug: t.slug,
      name: t.name,
      description: t.description,
      timezone: t.timezone,
      systemPromptTemplate: t.systemPromptTemplate,
      plannerRole: t.plannerRole,
      llmConfig: t.llmConfig,
      embeddingConfig: t.embeddingConfig,
      mcpServerToggles: t.mcpServerToggles,
    }),
  );
  if (t.companyContext) files.set('context.md', enc.encode(t.companyContext));
  for (const doc of t.documents) files.set(`knowledge/${doc.name}`, doc.data);

  for (const role of t.roles) {
    const dir = `roles/${role.slug}`;
    files.set(
      `${dir}/role.json`,
      json({
        name: role.name,
        description: role.description,
        llmConfig: role.llmConfig,
        systemPromptTemplate: role.systemPromptTemplate,
        mcpServerToggles: role.mcpServerToggles,
      }),
    );
    if (role.rolePrompt)
      files.set(`${dir}/prompt.md`, enc.encode(role.rolePrompt));
    for (const doc of role.documents) {
      files.set(`${dir}/knowledge/${doc.name}`, doc.data);
    }
  }

  const licences = licenceLines(files);
  if (licences.length > 0) {
    files.set(
      'LICENSES.md',
      enc.encode(
        `# Licences\n\nThe knowledge documents in this template carry these licences.\n\n${licences.join('\n')}\n`,
      ),
    );
  }
  return files;
}

/** The licence front matter of a Markdown document, where it has any. */
export interface DocumentLicence {
  license?: string;
  source?: string;
  attribution?: string;
}

/** Reads `license`, `source` and `attribution` from a document's front matter. */
export function documentLicence(text: string): DocumentLicence {
  const fm = parseFrontMatter(text) ?? {};
  const pick = (key: string) =>
    typeof fm[key] === 'string' && fm[key] ? fm[key] : undefined;
  return withoutEmpty({
    license: pick('license'),
    source: pick('source'),
    attribution: pick('attribution'),
  });
}

/** One Markdown list line per licensed knowledge document, in path order. */
function licenceLines(files: TemplateFiles): string[] {
  const dec = new TextDecoder();
  return [...files]
    .filter(([p]) => p.includes('knowledge/') && p.endsWith('.md'))
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([p, data]) => {
      const { license, source, attribution } = documentLicence(
        dec.decode(data),
      );
      if (!license) return [];
      const from = source ? ` (<${source}>)` : '';
      const credit = attribution ? ` ${attribution}` : '';
      return [`- \`${p}\`: ${license}${from}.${credit}`];
    });
}

/** Parses and validates one JSON file, adding any problems to `errors`. */
function readJson<T extends object>(
  cls: new () => T,
  where: string,
  data: Uint8Array,
  errors: string[],
): T | null {
  const text = readText(where, data, errors);
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    errors.push(`${where}: not valid JSON (${(err as Error).message})`);
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    errors.push(`${where}: must hold a JSON object`);
    return null;
  }
  const instance = plainToInstance(cls, raw);
  const problems = validateSync(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  if (problems.length > 0) {
    errors.push(...flatten(problems).map((msg) => `${where}: ${msg}`));
    return null;
  }
  return instance;
}

/** Decodes UTF-8 text, refusing bytes that aren't valid UTF-8. */
function readText(
  where: string,
  data: Uint8Array,
  errors: string[],
): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    errors.push(`${where}: not valid UTF-8 text`);
    return null;
  }
}

/** Checks a knowledge file's name has an extension an upload would accept. */
function checkDocName(where: string, name: string, errors: string[]): boolean {
  const ext = path.extname(name).toLowerCase();
  if ((SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) return true;
  errors.push(
    `${where}: knowledge must be one of ${SUPPORTED_EXTENSIONS.join(', ')}`,
  );
  return false;
}

/** Drops an `apiKey` from a template's model, with a warning. */
function keyless(
  config: LlmConfigDto | null | undefined,
  where: string,
  warnings: string[],
): LlmConfig | null {
  if (!config) return null;
  const { apiKey, ...rest } = config;
  if (apiKey !== undefined) {
    warnings.push(`${where}: the template held an API key; it was ignored.`);
  }
  return { ...rest };
}

/** Flattens class-validator errors, including nested ones, to messages. */
function flatten(errors: ValidationError[], prefix = ''): string[] {
  return errors.flatMap((e) => {
    const name = `${prefix}${e.property}`;
    const own = Object.values(e.constraints ?? {}).map((msg) =>
      msg.startsWith(e.property) ? `${prefix}${msg}` : `${name}: ${msg}`,
    );
    return [...own, ...flatten(e.children ?? [], `${name}.`)];
  });
}

/** Copies an object without its `null`, `undefined` and empty-string values. */
function withoutEmpty<T extends object>(v: T): T {
  return Object.fromEntries(
    Object.entries(v).filter(
      ([, x]) => x !== null && x !== undefined && x !== '',
    ),
  ) as T;
}

function mapOf<V>(m: Map<string, Map<string, V>>, k: string): Map<string, V> {
  const existing = m.get(k);
  if (existing) return existing;
  const created = new Map<string, V>();
  m.set(k, created);
  return created;
}

function listOf<V>(m: Map<string, V[]>, k: string): V[] {
  const existing = m.get(k);
  if (existing) return existing;
  const created: V[] = [];
  m.set(k, created);
  return created;
}
