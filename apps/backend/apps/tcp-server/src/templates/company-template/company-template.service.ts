import { BadRequestException, Injectable } from '@nestjs/common';
import {
  findProvider,
  LlmConfig,
  TcpCompany,
  TcpRole,
  validateOkf,
} from '@tcp/shared';
import { strToU8 } from 'fflate';
import { ApiService } from '../../api/api.service';
import {
  CompanyTemplatePreviewDto,
  ImportCompanyOptionsDto,
  TemplateDocumentPreviewDto,
} from '../../api/dto/company-template.dto';
import { toOkfDocument } from '../../api/knowledge-conversion';
import {
  KnowledgeScopeRef,
  KnowledgeService,
} from '../../api/knowledge.service';
import { RecordsCleanupService } from '../../api/records-cleanup.service';
import { DbService } from '../../db/db.service';
import { LlmDestinationPolicy } from '../../db/llm-destination-policy';
import { Originators } from '../../storage/storage.service';
import {
  CompanyTemplate,
  documentLicence,
  ParsedTemplate,
  parseTemplate,
  TEMPLATE_FORMAT_VERSION,
  TemplateDocument,
  TemplateRole,
  writeTemplate,
} from './format';
import { readZip, TEMPLATE_ZIP_LIMITS, writeZip } from './zip';

/** A knowledge document converted to OKF, ready to store. */
interface ConvertedDocument {
  filename: string;
  content: Buffer;
}

/** Who is importing, recorded as the new company's creator. */
export interface TemplateImporter {
  identifier: string;
  name: string | null;
  originators: Originators;
}

/** A company exported as a template zip. */
export interface TemplateDownload {
  filename: string;
  body: Uint8Array;
}

/**
 * Reads, previews, imports and exports company templates (format v1: a
 * company, its roles and their knowledge). Import and export both run here, so
 * the API, CLI and web client share one implementation.
 */
@Injectable()
export class CompanyTemplateService {
  constructor(
    private readonly db: DbService,
    private readonly api: ApiService,
    private readonly knowledge: KnowledgeService,
    private readonly llmPolicy: LlmDestinationPolicy,
    private readonly recordsCleanup: RecordsCleanupService,
  ) {}

  /** Unzips and parses an uploaded template. */
  read(zip: Uint8Array): ParsedTemplate {
    return parseTemplate(readZip(zip, TEMPLATE_ZIP_LIMITS));
  }

  /** What importing `parsed` would create, with nothing written. */
  async preview(parsed: ParsedTemplate): Promise<CompanyTemplatePreviewDto> {
    const t = parsed.template;
    const documents: TemplateDocumentPreviewDto[] = [
      ...t.documents.map((d) => describeDocument('shared', d)),
      ...t.roles.flatMap((r) =>
        r.documents.map((d) => describeDocument(r.slug, d)),
      ),
    ];
    return {
      formatVersion: TEMPLATE_FORMAT_VERSION,
      company: {
        slug: t.slug,
        name: t.name,
        description: t.description,
        timezone: t.timezone,
        companyContext: t.companyContext,
        llmConfig: t.llmConfig,
        embeddingConfig: t.embeddingConfig,
      },
      plannerRole: t.plannerRole,
      roles: t.roles.map((r) => ({
        slug: r.slug,
        name: r.name,
        description: r.description,
        llmConfig: r.llmConfig,
        documents: r.documents.length,
      })),
      documents,
      neededKeys: neededKeys([
        t.llmConfig,
        t.embeddingConfig,
        ...t.roles.map((r) => r.llmConfig),
      ]),
      slugTaken: (await this.db.getCompany(t.slug)) !== null,
      warnings: parsed.warnings,
    };
  }

  /**
   * Creates a company from a template. The caller has already checked that
   * the slug may be claimed (see `assertSlugClaimable`).
   *
   * Everything that can be checked is checked before anything is written:
   * each model against the URL policy, and each knowledge document converted
   * to OKF and validated. This matters most for a replace, which deletes the
   * old company first. If a write fails after the company exists, the new
   * company is deleted, so a failed import leaves nothing behind.
   *
   * @throws {@link BadRequestException} listing every problem found.
   */
  async import(
    parsed: ParsedTemplate,
    options: ImportCompanyOptionsDto,
    importer: TemplateImporter,
  ): Promise<TcpCompany> {
    const t = applyOptions(parsed.template, options);
    const errors: string[] = [];
    this.checkModel(t.llmConfig, 'llmConfig', errors);
    this.checkModel(t.embeddingConfig, 'embeddingConfig', errors);
    for (const role of t.roles) {
      this.checkModel(role.llmConfig, `roles/${role.slug}: llmConfig`, errors);
    }
    const shared = await convertAll('knowledge', t.documents, errors);
    const perRole = await Promise.all(
      t.roles.map((r) =>
        convertAll(`roles/${r.slug}/knowledge`, r.documents, errors),
      ),
    );
    if (errors.length > 0) {
      throw new BadRequestException(
        `The template can't be imported:\n- ${errors.join('\n- ')}`,
      );
    }

    const company = await this.api.createCompany(
      {
        name: t.name,
        description: t.description,
        timezone: t.timezone,
        companyContext: t.companyContext,
        systemPromptTemplate: t.systemPromptTemplate,
        llmConfig: t.llmConfig,
        embeddingConfig: t.embeddingConfig,
        mcpServerToggles: t.mcpServerToggles,
        mcpServerList: [],
      },
      t.slug,
      importer.identifier,
      importer.name,
      options.replace === true,
    );

    try {
      const roles: TcpRole[] = [];
      for (const role of t.roles) {
        roles.push(await this.db.setRole(roleFields(company.id, role)));
      }
      const planner = roles.find((r) => r.slug === t.plannerRole);
      if (planner) {
        await this.db.setCompany(
          { plannerRoleId: planner.id },
          { id: company.id },
        );
      }
      const scopes: [KnowledgeScopeRef, ConvertedDocument[]][] = [
        [{ kind: 'company', companyId: company.id }, shared],
        ...roles.map((r, i): [KnowledgeScopeRef, ConvertedDocument[]] => [
          { kind: 'role', roleId: r.id },
          perRole[i],
        ]),
      ];
      for (const [ref, docs] of scopes) {
        for (const doc of docs) {
          await this.knowledge.store(
            ref,
            doc.filename,
            doc.content,
            importer.originators,
          );
        }
      }
      return (await this.db.getCompany(company.id)) ?? company;
    } catch (err) {
      await this.db.deleteCompany(company.id);
      await this.recordsCleanup.companyDeleted(company.id);
      throw err;
    }
  }

  /**
   * Writes a company out as a template zip. API keys are always removed;
   * without `models`, every model is removed too, so the importer picks their
   * own.
   */
  async export(
    company: TcpCompany,
    models: boolean,
  ): Promise<TemplateDownload> {
    const model = (c: LlmConfig | null | undefined): LlmConfig | null => {
      if (!models || !c) return null;
      // Never write a key into something meant to be shared.
      const keyless = { ...c };
      delete keyless.apiKey;
      return keyless;
    };
    const roles = await this.db.listRoles(company.id);
    const template: CompanyTemplate = {
      slug: company.slug,
      name: company.name,
      description: company.description,
      timezone: company.timezone ?? null,
      companyContext: company.companyContext ?? null,
      systemPromptTemplate: company.systemPromptTemplate ?? null,
      plannerRole:
        roles.find((r) => r.id === company.plannerRoleId)?.slug ?? null,
      llmConfig: model(company.llmConfig),
      embeddingConfig: model(company.embeddingConfig),
      mcpServerToggles: company.mcpServerToggles ?? null,
      documents: await this.documentsOf({
        kind: 'company',
        companyId: company.id,
      }),
      roles: await Promise.all(
        roles.map(async (r) => ({
          slug: r.slug,
          name: r.name,
          description: r.description,
          rolePrompt: r.rolePrompt ?? null,
          llmConfig: model(r.llmConfig),
          systemPromptTemplate: r.systemPromptTemplate ?? null,
          mcpServerToggles: r.mcpServerToggles ?? null,
          documents: await this.documentsOf({ kind: 'role', roleId: r.id }),
        })),
      ),
    };
    return {
      filename: `${company.slug}.zip`,
      body: writeZip(writeTemplate(template)),
    };
  }

  /** Adds the URL policy's refusal of `config`, if any, to `errors`. */
  private checkModel(
    config: LlmConfig | null,
    where: string,
    errors: string[],
  ): void {
    if (!config) return;
    const reason = this.llmPolicy.refusal(config);
    if (reason) errors.push(`${where}: ${reason}`);
  }

  /** Every document in a knowledge scope, as template files. */
  private async documentsOf(
    ref: KnowledgeScopeRef,
  ): Promise<TemplateDocument[]> {
    const docs = await this.knowledge.list(ref);
    return Promise.all(
      docs.map(async (d) => ({
        name: d.name,
        data: strToU8(await this.knowledge.get(ref, d.name)),
      })),
    );
  }
}

/** Applies the importer's choices on top of the template's values. */
function applyOptions(
  t: CompanyTemplate,
  o: ImportCompanyOptionsDto,
): CompanyTemplate {
  const unknown = Object.keys(o.roleModels ?? {}).filter(
    (slug) => !t.roles.some((r) => r.slug === slug),
  );
  const notBoolean = Object.entries(o.roleModels ?? {}).filter(
    ([, keep]) => typeof keep !== 'boolean',
  );
  if (unknown.length > 0 || notBoolean.length > 0) {
    throw new BadRequestException(
      'roleModels must map role slugs in the template to true or false' +
        (unknown.length > 0 ? `; unknown: ${unknown.join(', ')}` : ''),
    );
  }
  const pick = <T>(chosen: T | undefined, fallback: T): T =>
    chosen === undefined ? fallback : chosen;
  return {
    ...t,
    slug: o.slug ?? t.slug,
    name: o.name ?? t.name,
    description: o.description ?? t.description,
    timezone: pick(o.timezone, t.timezone),
    companyContext: pick(o.companyContext, t.companyContext),
    llmConfig: pick(o.llmConfig, t.llmConfig),
    embeddingConfig: pick(o.embeddingConfig, t.embeddingConfig),
    roles: t.roles.map((r) => ({
      ...r,
      llmConfig: o.roleModels?.[r.slug] === false ? null : r.llmConfig,
    })),
  };
}

/** The fields of a new role created from a template role. */
function roleFields(companyId: TcpCompany['id'], role: TemplateRole) {
  return {
    companyId,
    slug: role.slug,
    name: role.name,
    description: role.description,
    rolePrompt: role.rolePrompt,
    llmConfig: role.llmConfig,
    systemPromptTemplate: role.systemPromptTemplate,
    mcpServerToggles: role.mcpServerToggles,
    knowledgeDomains: [],
    mcpServerList: [],
  };
}

/**
 * Converts each document to OKF as an upload would, adding a problem to
 * `errors` for any that fails conversion or validation, or that would land on
 * another document's name.
 */
async function convertAll(
  where: string,
  docs: TemplateDocument[],
  errors: string[],
): Promise<ConvertedDocument[]> {
  const out: ConvertedDocument[] = [];
  for (const doc of docs) {
    try {
      const { filename, content } = await toOkfDocument(
        doc.name,
        Buffer.from(doc.data),
      );
      const check = validateOkf(content);
      if (!check.valid) {
        errors.push(
          `${where}/${doc.name}: ${check.errors.map((e) => e.message).join('; ')}`,
        );
      } else if (out.some((o) => o.filename === filename)) {
        errors.push(
          `${where}/${doc.name}: another document also becomes ${filename}`,
        );
      } else {
        out.push({ filename, content: Buffer.from(content, 'utf-8') });
      }
    } catch (err) {
      errors.push(`${where}/${doc.name}: ${(err as Error).message}`);
    }
  }
  return out;
}

/** A document's name and, for Markdown, the licence its front matter names. */
function describeDocument(
  scope: string,
  doc: TemplateDocument,
): TemplateDocumentPreviewDto {
  const licence = doc.name.toLowerCase().endsWith('.md')
    ? documentLicence(new TextDecoder().decode(doc.data))
    : {};
  return {
    scope,
    name: doc.name,
    license: licence.license,
    source: licence.source,
  };
}

/** Names of the catalogue providers among `configs` that need an API key. */
function neededKeys(configs: (LlmConfig | null)[]): string[] {
  const names = configs.flatMap((c) => {
    const provider = c ? findProvider(c.provider) : undefined;
    return provider?.fields.includes('apiKey') ? [provider.name] : [];
  });
  return [...new Set(names)].sort();
}
