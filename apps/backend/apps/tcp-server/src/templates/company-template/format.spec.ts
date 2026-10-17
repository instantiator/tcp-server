import { strFromU8, strToU8 } from 'fflate';
import {
  CompanyTemplate,
  documentLicence,
  parseTemplate,
  writeTemplate,
} from './format';
import type { TemplateFiles } from './zip';

/** A template's files from path → text pairs. */
function files(entries: Record<string, string>): TemplateFiles {
  return new Map(Object.entries(entries).map(([p, t]) => [p, strToU8(t)]));
}

const COMPANY = {
  formatVersion: 1,
  slug: 'acme',
  name: 'Acme',
  description: 'Makes things',
};

const OKF =
  '---\ntitle: Guide\nlicense: CC-BY-4.0\nsource: https://example.org/guide\n---\nBody';

/** Every message parseTemplate refused `t` with. */
function problems(t: TemplateFiles): string {
  try {
    parseTemplate(t);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected parseTemplate to refuse the template');
}

describe('parseTemplate', () => {
  it('reads a full template', () => {
    const { template, warnings } = parseTemplate(
      files({
        'company.json': JSON.stringify({
          ...COMPANY,
          timezone: 'Europe/London',
          plannerRole: 'planner',
          llmConfig: { provider: 'openai-compatible', model: 'm' },
          mcpServerToggles: { records: true },
        }),
        'context.md': 'We make things.',
        'README.md': 'For people only.',
        'knowledge/guide.md': OKF,
        'knowledge/.gitkeep': '',
        'roles/planner/role.json': JSON.stringify({
          name: 'Planner',
          description: 'Plans',
        }),
        'roles/planner/prompt.md': 'Plan well.',
        'roles/planner/knowledge/notes.txt': 'notes',
      }),
    );
    expect(warnings).toEqual([]);
    expect(template).toMatchObject({
      slug: 'acme',
      timezone: 'Europe/London',
      companyContext: 'We make things.',
      plannerRole: 'planner',
      llmConfig: { provider: 'openai-compatible', model: 'm' },
      mcpServerToggles: { records: true },
    });
    expect(template.documents.map((d) => d.name)).toEqual(['guide.md']);
    expect(template.roles).toHaveLength(1);
    expect(template.roles[0]).toMatchObject({
      slug: 'planner',
      name: 'Planner',
      rolePrompt: 'Plan well.',
      llmConfig: null,
    });
    expect(template.roles[0].documents.map((d) => d.name)).toEqual([
      'notes.txt',
    ]);
  });

  it('refuses a template without company.json', () => {
    expect(problems(files({ 'context.md': 'x' }))).toMatch(
      /company\.json: missing/,
    );
  });

  it('refuses a newer format version with a plain explanation', () => {
    const t = files({
      'company.json': JSON.stringify({ ...COMPANY, formatVersion: 2 }),
    });
    expect(problems(t)).toMatch(/format version 2.*newer version of TCP/s);
  });

  it('refuses unknown keys, naming the file and key', () => {
    const t = files({
      'company.json': JSON.stringify({ ...COMPANY, plannerRol: 'x' }),
    });
    expect(problems(t)).toMatch(/company\.json: .*plannerRol/);
  });

  it('refuses a malformed nested model, naming the field', () => {
    const t = files({
      'company.json': JSON.stringify({ ...COMPANY, llmConfig: { model: 'm' } }),
    });
    expect(problems(t)).toMatch(/company\.json: llmConfig\.provider/);
  });

  it('refuses a plannerRole with no role folder', () => {
    const t = files({
      'company.json': JSON.stringify({ ...COMPANY, plannerRole: 'boss' }),
    });
    expect(problems(t)).toMatch(/plannerRole "boss" has no roles\/boss\//);
  });

  it.each([
    ['upper case', 'Planner'],
    ['the reserved shared slug', 'shared'],
  ])('refuses a role folder in %s', (_label, slug) => {
    const t = files({
      'company.json': JSON.stringify(COMPANY),
      [`roles/${slug}/role.json`]: JSON.stringify({
        name: 'x',
        description: 'y',
      }),
    });
    expect(problems(t)).toMatch(new RegExp(`roles/${slug}: a role folder`));
  });

  it('refuses a role without role.json', () => {
    const t = files({
      'company.json': JSON.stringify(COMPANY),
      'roles/a/prompt.md': 'x',
    });
    expect(problems(t)).toMatch(/roles\/a\/role\.json: missing/);
  });

  it('refuses files outside the layout and unsupported knowledge', () => {
    const msg = problems(
      files({
        'company.json': JSON.stringify(COMPANY),
        'scripts/run.sh': 'x',
        'knowledge/tool.exe': 'x',
        'knowledge/deep/a.md': OKF,
      }),
    );
    expect(msg).toMatch(/scripts\/run\.sh: not part of the template layout/);
    expect(msg).toMatch(/knowledge\/tool\.exe: knowledge must be one of/);
    expect(msg).toMatch(/knowledge\/deep\/a\.md: not part of/);
  });

  it('reports every problem at once', () => {
    const msg = problems(
      files({
        'company.json': JSON.stringify({ ...COMPANY, name: '' }),
        'roles/a/prompt.md': 'x',
      }),
    );
    expect(msg).toMatch(/company\.json: name/);
    expect(msg).toMatch(/roles\/a\/role\.json: missing/);
  });

  it('refuses invalid JSON and invalid UTF-8', () => {
    const t = files({ 'company.json': '{ nope' });
    expect(problems(t)).toMatch(/company\.json: not valid JSON/);
    const bad = new Map([
      ['company.json', strToU8(JSON.stringify(COMPANY))],
      ['context.md', new Uint8Array([0xff, 0xfe])],
    ]);
    expect(problems(bad)).toMatch(/context\.md: not valid UTF-8/);
  });

  it('drops API keys with a warning', () => {
    const { template, warnings } = parseTemplate(
      files({
        'company.json': JSON.stringify({
          ...COMPANY,
          llmConfig: { provider: 'openai', model: 'm', apiKey: 'sk-secret' },
        }),
        'roles/a/role.json': JSON.stringify({
          name: 'A',
          description: 'a',
          llmConfig: { provider: 'openai', model: 'm', apiKey: 'sk-2' },
        }),
      }),
    );
    expect(template.llmConfig).toEqual({ provider: 'openai', model: 'm' });
    expect(template.roles[0].llmConfig).toEqual({
      provider: 'openai',
      model: 'm',
    });
    expect(warnings).toHaveLength(2);
    expect(JSON.stringify(template)).not.toContain('sk-');
  });
});

describe('writeTemplate', () => {
  const template: CompanyTemplate = {
    slug: 'acme',
    name: 'Acme',
    description: 'Makes things',
    timezone: null,
    companyContext: 'Context',
    systemPromptTemplate: null,
    plannerRole: 'planner',
    llmConfig: null,
    embeddingConfig: null,
    mcpServerToggles: null,
    documents: [{ name: 'guide.md', data: strToU8(OKF) }],
    roles: [
      {
        slug: 'planner',
        name: 'Planner',
        description: 'Plans',
        rolePrompt: 'Plan well.',
        llmConfig: { provider: 'openai-compatible', model: 'm' },
        systemPromptTemplate: null,
        mcpServerToggles: null,
        documents: [],
      },
    ],
  };

  it('round-trips through parseTemplate', () => {
    expect(parseTemplate(writeTemplate(template)).template).toEqual(template);
  });

  it('leaves out empty fields and writes the format version', () => {
    const company = JSON.parse(
      strFromU8(writeTemplate(template).get('company.json')!),
    ) as Record<string, unknown>;
    expect(company).toEqual({
      formatVersion: 1,
      slug: 'acme',
      name: 'Acme',
      description: 'Makes things',
      plannerRole: 'planner',
    });
  });

  it('lists document licences in LICENSES.md', () => {
    const licences = strFromU8(writeTemplate(template).get('LICENSES.md')!);
    expect(licences).toContain(
      '- `knowledge/guide.md`: CC-BY-4.0 (<https://example.org/guide>).',
    );
  });

  it('writes no LICENSES.md when no document names a licence', () => {
    const files = writeTemplate({ ...template, documents: [] });
    expect(files.has('LICENSES.md')).toBe(false);
  });
});

describe('documentLicence', () => {
  it('reads licence fields from front matter', () => {
    expect(documentLicence(OKF)).toEqual({
      license: 'CC-BY-4.0',
      source: 'https://example.org/guide',
    });
  });

  it('is empty for a document without them', () => {
    expect(documentLicence('---\ntitle: T\n---\n')).toEqual({});
    expect(documentLicence('no front matter')).toEqual({});
  });
});
