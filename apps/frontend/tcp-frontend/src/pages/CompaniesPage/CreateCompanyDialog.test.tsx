import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { announce } from '../../announce/announcer';
import { t } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import {
  fetchMock,
  installFetchMock,
  respondByRoute,
} from '../../test-support/fetch-mock';
import type { CompanyTemplatePreview } from '../../api/dtos';
import { CreateCompanyDialog } from './CreateCompanyDialog';

vi.mock('../../announce/announcer', () => ({ announce: vi.fn() }));

const CREATED = { id: 'c9', slug: 'acme', name: 'Acme', description: 'd' };

const routes = [
  [
    /\/api\/system\/llm-defaults$/,
    {
      body: {
        chat: { provider: 'openai', model: 'gpt-5-mini' },
        embedding: null,
        embeddingDimension: 768,
      },
    },
  ],
  [/\/llm\/models$/, { body: { models: [] } }],
  [/\/api\/company$/, { status: 201, body: CREATED }],
] as const;

/** Shows where the router ended up, so navigation can be asserted. */
const Where = () => {
  const { pathname, hash } = useLocation();
  return <p data-testid="where">{pathname + hash}</p>;
};

const onClose = vi.fn();

const renderDialog = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <CreateCompanyDialog isOpen onClose={onClose} />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

/** The bodies of the company POSTs made so far. */
const sentBodies = async (): Promise<unknown[]> => {
  const writes = fetchMock.mock.calls
    .map(([input]) => input)
    .filter(
      (input): input is Request =>
        input instanceof Request &&
        input.method === 'POST' &&
        input.url.endsWith('/api/company'),
    );
  return Promise.all(writes.map((request) => request.clone().json()));
};

type User = ReturnType<typeof userEvent.setup>;

const nameField = () => screen.findByRole('textbox', { name: /^Name/ });
const slugField = () => screen.getByRole('textbox', { name: /^Slug/ });

/** Fills the three required fields. */
const fillRequired = async (user: User) => {
  await user.type(await nameField(), 'Acme');
  await user.type(
    screen.getByRole('textbox', { name: /^Description/ }),
    'Makes things.',
  );
};

const create = (user: User) =>
  user.click(
    screen.getByRole('button', { name: t('companies.create.submit') }),
  );

/** Picks a provider in the chat model's picker (the first one on the form). */
const chooseChatProvider = async (user: User, name: string | RegExp) => {
  const [chat] = await screen.findAllByRole('button', { name: /Provider$/ });
  if (chat === undefined) throw new Error('no provider picker');
  await user.click(chat);
  await user.click(await screen.findByRole('option', { name }));
};

describe('CreateCompanyDialog', () => {
  beforeEach(() => {
    installFetchMock();
    respondByRoute([...routes]);
    vi.mocked(announce).mockClear();
    onClose.mockClear();
  });

  it('follows the name with the slug until the slug is edited', async () => {
    const user = userEvent.setup();
    renderDialog();
    const name = await nameField();
    await user.type(name, 'Big Acme');
    expect(slugField()).toHaveValue('big-acme');

    await user.type(slugField(), '-x');
    await user.type(name, ' Co');
    expect(slugField()).toHaveValue('big-acme-x');
  });

  it('sends nothing when required fields are empty, and focuses Name', async () => {
    const user = userEvent.setup();
    renderDialog();
    await nameField();
    await create(user);

    expect(await nameField()).toHaveFocus();
    expect(await nameField()).toHaveAccessibleDescription(
      expect.stringContaining(t('companies.create.nameRequired')),
    );
    expect(await sentBodies()).toEqual([]);
  });

  it('leaves both models out when they inherit', async () => {
    const user = userEvent.setup();
    renderDialog();
    await fillRequired(user);
    await create(user);

    await waitFor(() => expect(announce).toHaveBeenCalled());
    const [body] = await sentBodies();
    expect(body).toMatchObject({
      slug: 'acme',
      name: 'Acme',
      description: 'Makes things.',
    });
    expect(body).not.toHaveProperty('llmConfig');
    expect(body).not.toHaveProperty('embeddingConfig');
    expect(body).not.toHaveProperty('companyContext');
  });

  it('sends a chosen model whole, without an api key key', async () => {
    const user = userEvent.setup();
    renderDialog();
    await fillRequired(user);
    await chooseChatProvider(user, /OpenAI.compatible/i);
    await user.type(
      screen.getByRole('textbox', { name: /^Address/ }),
      'https://llm.example.com/v1',
    );
    await user.type(screen.getByRole('combobox', { name: /^Model/ }), 'tiny');
    await create(user);

    await waitFor(() => expect(announce).toHaveBeenCalled());
    const [body] = await sentBodies();
    expect(body).toMatchObject({
      llmConfig: {
        provider: 'openai-compatible',
        model: 'tiny',
        baseUrl: 'https://llm.example.com/v1',
      },
    });
    expect(JSON.stringify(body)).not.toContain('apiKey');
    expect(body).not.toHaveProperty('embeddingConfig');
  });

  it('offers host.docker.internal for a localhost address', async () => {
    const user = userEvent.setup();
    renderDialog();
    await fillRequired(user);
    await chooseChatProvider(user, 'LM Studio');
    await user.type(screen.getByRole('combobox', { name: /^Model/ }), 'tiny');
    await create(user);
    await user.click(
      await screen.findByRole('button', { name: t('llm.local.replace') }),
    );

    await waitFor(() => expect(announce).toHaveBeenCalled());
    const [body] = await sentBodies();
    expect(body).toMatchObject({
      llmConfig: {
        provider: 'lm-studio',
        baseUrl: 'http://host.docker.internal:1234/v1',
      },
    });
  });

  it('shows a taken slug on the slug field and stays open', async () => {
    const user = userEvent.setup();
    respondByRoute([
      ...routes.filter(([pattern]) => !pattern.test('/api/company')),
      [/\/api\/company$/, { status: 409, body: { message: 'exists' } }],
    ]);
    renderDialog();
    await fillRequired(user);
    await create(user);

    await waitFor(() =>
      expect(slugField()).toHaveAccessibleDescription(
        expect.stringContaining(t('companies.create.slugTaken')),
      ),
    );
    expect(slugField()).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
  });

  it('closes, announces and opens the new company’s roles on success', async () => {
    const user = userEvent.setup();
    renderDialog();
    await fillRequired(user);
    await create(user);

    await waitFor(() =>
      expect(screen.getByTestId('where')).toHaveTextContent(
        '/company/c9#admin/roles',
      ),
    );
    expect(onClose).toHaveBeenCalled();
    expect(announce).toHaveBeenCalledWith({
      channel: 'companies',
      change: 'companies.create.announce',
    });
  });

  it('blocks an unknown time zone', async () => {
    const user = userEvent.setup();
    renderDialog();
    await fillRequired(user);
    const zone = screen.getByRole('combobox', { name: /^Time zone/ });
    await user.clear(zone);
    await user.type(zone, 'Mars/Olympus');
    await create(user);

    expect(zone).toHaveAccessibleDescription(
      expect.stringContaining(t('companies.create.timezoneInvalid')),
    );
    expect(zone).toHaveFocus();
    expect(await sentBodies()).toEqual([]);
  });

  it('has no accessibility violations', async () => {
    renderDialog();
    await nameField();
    await expectNoA11yViolations(document.body);
  });
});

const PREVIEW: CompanyTemplatePreview = {
  formatVersion: 1,
  company: {
    slug: 'cottage',
    name: 'Cottage industry',
    description: 'Sells crafts.',
    timezone: 'Europe/London',
    companyContext: 'We sell at fairs.',
    llmConfig: { provider: 'anthropic', model: 'claude-x' },
    embeddingConfig: null,
  },
  plannerRole: 'planner',
  roles: [
    {
      slug: 'planner',
      name: 'Planner',
      description: 'Plans the work.',
      llmConfig: { provider: 'openai', model: 'gpt-x' },
      documents: 1,
    },
    {
      slug: 'writer',
      name: 'Writer',
      description: 'Writes copy.',
      llmConfig: null,
      documents: 0,
    },
  ],
  documents: [
    { scope: 'company', name: 'a.md', license: 'CC-BY-4.0' },
    { scope: 'company', name: 'b.md', license: 'CC-BY-4.0' },
    { scope: 'planner', name: 'c.md' },
  ],
  neededKeys: ['anthropic', 'openai'],
  slugTaken: false,
  warnings: ['The template held an API key; it was ignored.'],
};

const IMPORTED = { id: 'c7', slug: 'cottage', name: 'Cottage industry' };

const importRoutes = [
  ...routes.filter(([pattern]) => !pattern.test('/api/company')),
  [/\/api\/company\/import$/, { status: 201, body: IMPORTED }],
] as const;

/** The multipart bodies of the import requests made so far. */
const importForms = (): FormData[] =>
  fetchMock.mock.calls.flatMap(([input, init]) =>
    (input instanceof Request ? input.url : String(input)).endsWith(
      '/api/company/import',
    ) && init?.body instanceof FormData
      ? [init.body]
      : [],
  );

/** The `options` field of each import request made so far. */
const sentOptions = (): unknown[] =>
  importForms().map((form) => {
    const options = form.get('options');
    const parsed: unknown =
      typeof options === 'string' ? JSON.parse(options) : null;
    return parsed;
  });

const renderImport = (source: File | string = 'builtin/cottage') =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <CreateCompanyDialog
                  isOpen
                  onClose={onClose}
                  template={{ preview: PREVIEW, source }}
                />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

const importButton = () =>
  screen.getByRole('button', { name: t('companies.import.submit') });

describe('CreateCompanyDialog with a template', () => {
  beforeEach(() => {
    installFetchMock();
    respondByRoute([...importRoutes]);
    vi.mocked(announce).mockClear();
    onClose.mockClear();
  });

  it('is headed by the template and prefilled from it', async () => {
    renderImport();

    expect(
      await screen.findByRole('heading', {
        name: t('companies.import.heading', { name: 'Cottage industry' }),
      }),
    ).toBeInTheDocument();
    expect(await nameField()).toHaveValue('Cottage industry');
    expect(slugField()).toHaveValue('cottage');
    expect(screen.getByRole('textbox', { name: /^Description/ })).toHaveValue(
      'Sells crafts.',
    );
    expect(screen.getByRole('combobox', { name: /^Time zone/ })).toHaveValue(
      'Europe/London',
    );
    expect(
      screen.getByRole('textbox', { name: /^Company context/ }),
    ).toHaveValue('We sell at fairs.');
    expect(
      screen.getAllByRole('button', { name: /Provider$/ })[0],
    ).toHaveTextContent(/Anthropic/i);
  });

  it('keeps the template’s slug when the name is edited', async () => {
    const user = userEvent.setup();
    renderImport();
    await user.type(await nameField(), ' Two');
    expect(slugField()).toHaveValue('cottage');
  });

  it('says which keys are needed, and shows the template’s warnings', async () => {
    renderImport();
    await nameField();

    expect(
      screen.getByText(
        t('companies.import.needsKey', { provider: 'anthropic' }),
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(t('companies.import.needsKey', { provider: 'openai' })),
    ).toBeInTheDocument();
    expect(
      screen.getByText('The template held an API key; it was ignored.'),
    ).toBeInTheDocument();
  });

  it('lists the roles, offering a model only to a role that has one', async () => {
    renderImport();
    await nameField();

    const roles = screen.getByRole('group', {
      name: t('companies.import.roles'),
    });
    expect(within(roles).getByText('Planner')).toBeInTheDocument();
    expect(within(roles).getByText('Writes copy.')).toBeInTheDocument();
    const boxes = within(roles).getAllByRole('checkbox');
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toBeChecked();
    expect(boxes[0]).toHaveAccessibleName(
      t('companies.import.roleModel', { provider: 'openai', model: 'gpt-x' }),
    );
    expect(boxes[0]).toHaveAccessibleDescription('Planner');
    expect(screen.getByText(/3 knowledge documents/)).toHaveTextContent(
      'Licences: CC-BY-4.0',
    );
  });

  it('sends both models explicitly, and no roleModels by default', async () => {
    const user = userEvent.setup();
    renderImport();
    await nameField();
    await user.click(importButton());

    await waitFor(() => expect(announce).toHaveBeenCalled());
    const [options] = sentOptions();
    expect(options).toMatchObject({
      slug: 'cottage',
      name: 'Cottage industry',
      description: 'Sells crafts.',
      timezone: 'Europe/London',
      companyContext: 'We sell at fairs.',
      llmConfig: { provider: 'anthropic', model: 'claude-x' },
      embeddingConfig: null,
    });
    expect(options).not.toHaveProperty('roleModels');
    expect(options).not.toHaveProperty('replace');
  });

  it('sends roleModels false for a role whose model is unchecked', async () => {
    const user = userEvent.setup();
    renderImport();
    await nameField();
    await user.click(screen.getByRole('checkbox'));
    await user.click(importButton());

    await waitFor(() => expect(announce).toHaveBeenCalled());
    const [options] = sentOptions();
    expect(options).toMatchObject({ roleModels: { planner: false } });
  });

  it('sends the zip file itself when the template is one', async () => {
    const user = userEvent.setup();
    const file = new File(['zip'], 'mine.zip');
    renderImport(file);
    await nameField();
    await user.click(importButton());

    await waitFor(() => expect(announce).toHaveBeenCalled());
    expect(importForms()[0]?.get('file')).toBeInstanceOf(File);
  });

  it('announces, closes and opens the new company on success', async () => {
    const user = userEvent.setup();
    renderImport();
    await nameField();
    await user.click(importButton());

    await waitFor(() =>
      expect(screen.getByTestId('where')).toHaveTextContent('/company/c7'),
    );
    expect(screen.getByTestId('where')).not.toHaveTextContent('#');
    expect(onClose).toHaveBeenCalled();
    expect(announce).toHaveBeenCalledWith({
      channel: 'companies',
      change: 'companies.import.announce',
    });
  });

  describe('when the slug is taken', () => {
    let imports: number;
    beforeEach(() => {
      imports = 0;
      fetchMock.mockImplementation((input) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith('/api/company/import')) {
          imports += 1;
          // The first try is refused; the replace goes through.
          return Promise.resolve(
            new Response(
              JSON.stringify(imports === 1 ? { message: 'taken' } : IMPORTED),
              {
                status: imports === 1 ? 409 : 201,
                headers: { 'Content-Type': 'application/json' },
              },
            ),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              chat: null,
              embedding: null,
              embeddingDimension: 768,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      });
    });

    it('asks, then resends with replace when agreed', async () => {
      const user = userEvent.setup();
      renderImport();
      await nameField();
      await user.click(importButton());

      expect(
        await screen.findByRole('alertdialog', {
          name: t('companies.import.replaceHeading', { slug: 'cottage' }),
        }),
      ).toBeInTheDocument();
      await user.click(
        screen.getByRole('button', {
          name: t('companies.import.replaceConfirm'),
        }),
      );

      await waitFor(() =>
        expect(screen.getByTestId('where')).toHaveTextContent('/company/c7'),
      );
      const [first, second] = sentOptions();
      expect(first).not.toHaveProperty('replace');
      expect(second).toMatchObject({ slug: 'cottage', replace: true });
    });

    it('puts the problem on the slug when declined', async () => {
      const user = userEvent.setup();
      renderImport();
      await nameField();
      await user.click(importButton());
      await user.click(
        await screen.findByRole('button', { name: t('confirm.no') }),
      );

      await waitFor(() =>
        expect(slugField()).toHaveAccessibleDescription(
          expect.stringContaining(t('companies.import.slugTaken')),
        ),
      );
      await waitFor(() => expect(slugField()).toHaveFocus());
      expect(sentOptions()).toHaveLength(1);
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  it('says only members can replace when the replace is refused', async () => {
    const user = userEvent.setup();
    let imports = 0;
    fetchMock.mockImplementation((input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/api/company/import')) {
        imports += 1;
        return Promise.resolve(
          new Response(JSON.stringify({ message: 'no' }), {
            status: imports === 1 ? 409 : 403,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            chat: null,
            embedding: null,
            embeddingDimension: 768,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    });
    renderImport();
    await nameField();
    await user.click(importButton());
    await user.click(
      await screen.findByRole('button', {
        name: t('companies.import.replaceConfirm'),
      }),
    );

    expect(
      await screen.findByText(t('companies.import.replaceForbidden')),
    ).toBeVisible();
  });

  it('has no accessibility violations', async () => {
    renderImport();
    await nameField();
    await expectNoA11yViolations(document.body);
  });
});
