import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { announce } from '../../../announce/announcer';
import { t } from '../../../strings';
import { expectNoA11yViolations } from '../../../test-support/axe';
import {
  fetchMock,
  installFetchMock,
  respondByRoute,
} from '../../../test-support/fetch-mock';
import { LanguageModelsAdmin } from './LanguageModelsAdmin';

vi.mock('../../../announce/announcer', () => ({ announce: vi.fn() }));

const CHAT = {
  provider: 'lm-studio',
  model: 'gemma',
  baseUrl: 'http://host.docker.internal:1234/v1',
  apiKey: '***',
};

const EMBEDDING = {
  provider: 'lm-studio',
  model: 'text-embedding-nomic-embed-text-v1.5',
  baseUrl: 'http://host.docker.internal:1234/v1',
  apiKey: '***',
};

const BARE_COMPANY = { id: 'c1', slug: 'acme', name: 'Acme' };

const DEFAULTS = {
  chat: { provider: 'openai', model: 'gpt-5-mini' },
  embedding: { provider: 'openai', model: 'text-embedding-3-small' },
  embeddingDimension: 768,
};

const ROLE = { id: 'r1', companyId: 'c1', name: 'Writer', llmConfig: null };

/** Answers the page's reads; the PUT is answered with the same company. */
const routes = (
  company: object = BARE_COMPANY,
  defaults: object = DEFAULTS,
  roles: object[] = [ROLE],
) =>
  [
    [/\/api\/company\/c1\/roles$/, { body: roles }],
    [/\/api\/company\/c1$/, { body: company }],
    [/\/api\/system\/llm-defaults$/, { body: defaults }],
    [/\/llm\/models$/, { body: { models: [] } }],
  ] as const;

const render_ = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <LanguageModelsAdmin companyId="c1" />
    </QueryClientProvider>,
  );

/** The bodies of the PUT requests made so far (the model listing is a POST). */
const sentBodies = async (): Promise<unknown[]> => {
  const writes = fetchMock.mock.calls
    .map(([input]) => input)
    .filter(
      (input): input is Request =>
        input instanceof Request && input.method === 'PUT',
    );
  return Promise.all(writes.map((request) => request.clone().json()));
};

/** One picker's group, once the form has loaded. */
const group = async (name: string) =>
  within(await screen.findByRole('group', { name }));

/** Opens a group's provider list and picks `name`. */
const chooseProvider = async (
  user: ReturnType<typeof userEvent.setup>,
  groupName: string,
  name: string | RegExp,
) => {
  const picker = await group(groupName);
  await user.click(picker.getByRole('button', { name: /Provider/ }));
  await user.click(await screen.findByRole('option', { name }));
};

const save = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: t('admin.models.save') }));

const CHAT_GROUP = t('admin.models.chat');
const EMBEDDING_GROUP = t('admin.models.embedding');
const USE_DEFAULT = /Use the app default/;

describe('LanguageModelsAdmin', () => {
  beforeEach(() => {
    installFetchMock();
    respondByRoute([...routes()]);
    vi.mocked(announce).mockClear();
  });

  it('shows both pickers, each naming the app default it would use', async () => {
    render_();
    const chat = await group(CHAT_GROUP);
    const embedding = await group(EMBEDDING_GROUP);
    expect(
      chat.getByRole('button', { name: /gpt-5-mini/ }),
    ).toBeInTheDocument();
    expect(
      embedding.getByRole('button', { name: /text-embedding-3-small/ }),
    ).toBeInTheDocument();
  });

  it('sends nothing when nothing changed', async () => {
    const user = userEvent.setup();
    render_();
    await group(CHAT_GROUP);
    await save(user);
    expect(await sentBodies()).toEqual([]);
    expect(announce).not.toHaveBeenCalled();
  });

  it('clears the chat model without asking when the app has a default', async () => {
    const user = userEvent.setup();
    respondByRoute([...routes({ ...BARE_COMPANY, llmConfig: CHAT })]);
    render_();
    await chooseProvider(user, CHAT_GROUP, USE_DEFAULT);
    await save(user);

    await waitFor(() => expect(announce).toHaveBeenCalled());
    expect(await sentBodies()).toEqual([{ llmConfig: null }]);
    expect(announce).toHaveBeenCalledWith({
      channel: 'models',
      change: 'admin.models.announce.saved',
    });
  });

  describe('with no app default chat model', () => {
    beforeEach(() => {
      respondByRoute([
        ...routes(
          { ...BARE_COMPANY, llmConfig: CHAT },
          { ...DEFAULTS, chat: null },
        ),
      ]);
    });

    it('names the roles left without a model, and sends nothing on No', async () => {
      const user = userEvent.setup();
      render_();
      await chooseProvider(user, CHAT_GROUP, /None/);
      await save(user);

      const dialog = await screen.findByRole('alertdialog', {
        name: t('admin.models.noModel.heading'),
      });
      expect(dialog).toHaveTextContent('Writer');
      await user.click(within(dialog).getByRole('button', { name: 'No' }));
      expect(await sentBodies()).toEqual([]);
    });

    it('sends the clear on Save anyway', async () => {
      const user = userEvent.setup();
      render_();
      await chooseProvider(user, CHAT_GROUP, /None/);
      await save(user);
      await user.click(
        await screen.findByRole('button', {
          name: t('admin.models.noModel.confirm'),
        }),
      );
      await waitFor(() => expect(announce).toHaveBeenCalled());
      expect(await sentBodies()).toEqual([{ llmConfig: null }]);
    });
  });

  describe('changing the embedding model', () => {
    const change = async (user: ReturnType<typeof userEvent.setup>) => {
      respondByRoute([
        ...routes({ ...BARE_COMPANY, embeddingConfig: EMBEDDING }),
      ]);
      render_();
      const embedding = await group(EMBEDDING_GROUP);
      const model = embedding.getByRole('combobox', { name: /Model/ });
      await user.clear(model);
      await user.type(model, 'other-embed');
      await save(user);
      return screen.findByRole('alertdialog', {
        name: t('admin.models.reindex.heading'),
      });
    };

    it('asks about re-indexing, and sends nothing on No', async () => {
      const user = userEvent.setup();
      const dialog = await change(user);
      await user.click(within(dialog).getByRole('button', { name: 'No' }));
      expect(await sentBodies()).toEqual([]);
    });

    it('sends the new model, with no api key, on confirming', async () => {
      const user = userEvent.setup();
      await change(user);
      await user.click(
        screen.getByRole('button', { name: t('admin.models.reindex.confirm') }),
      );
      await waitFor(() => expect(announce).toHaveBeenCalled());
      const bodies = await sentBodies();
      expect(bodies).toEqual([
        {
          embeddingConfig: expect.objectContaining({
            provider: 'lm-studio',
            model: 'other-embed',
          }) as unknown,
        },
      ]);
      expect(JSON.stringify(bodies)).not.toContain('apiKey');
    });
  });

  it('offers host.docker.internal for a localhost address, and sends the rewrite', async () => {
    const user = userEvent.setup();
    render_();
    await chooseProvider(user, CHAT_GROUP, 'LM Studio');
    await save(user);
    await user.click(
      await screen.findByRole('button', { name: t('llm.local.replace') }),
    );

    await waitFor(() => expect(announce).toHaveBeenCalled());
    expect(await sentBodies()).toEqual([
      {
        llmConfig: expect.objectContaining({
          provider: 'lm-studio',
          baseUrl: 'http://host.docker.internal:1234/v1',
        }) as unknown,
      },
    ]);
    expect(JSON.stringify(await sentBodies())).not.toContain('***');
  });

  it('shows a server 400', async () => {
    const user = userEvent.setup();
    respondByRoute([...routes({ ...BARE_COMPANY, llmConfig: CHAT })]);
    const base = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((input, init) =>
      input instanceof Request && input.method === 'PUT'
        ? Promise.resolve(
            new Response(JSON.stringify({ message: 'model refused' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }),
          )
        : (base?.(input, init) ?? Promise.reject(new Error('no fetch'))),
    );
    render_();
    await chooseProvider(user, CHAT_GROUP, USE_DEFAULT);
    await save(user);
    expect(await screen.findByText('model refused')).toBeInTheDocument();
    expect(announce).not.toHaveBeenCalled();
  });

  it('shows the server’s warnings after a save', async () => {
    const user = userEvent.setup();
    respondByRoute([...routes({ ...BARE_COMPANY, llmConfig: CHAT })]);
    const base = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((input, init) =>
      input instanceof Request && input.method === 'PUT'
        ? Promise.resolve(
            new Response(JSON.stringify(BARE_COMPANY), {
              status: 200,
              headers: {
                'Content-Type': 'application/json',
                'X-Tcp-Warnings': JSON.stringify([
                  encodeURIComponent('Context window is small.'),
                ]),
              },
            }),
          )
        : (base?.(input, init) ?? Promise.reject(new Error('no fetch'))),
    );
    render_();
    await chooseProvider(user, CHAT_GROUP, USE_DEFAULT);
    await save(user);
    expect(
      await screen.findByText('Context window is small.'),
    ).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    render_();
    await group(CHAT_GROUP);
    await expectNoA11yViolations(document.body);
  });
});
