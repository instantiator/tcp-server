import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
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
