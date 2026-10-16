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
import { RoleDialog } from './RoleDialog';

vi.mock('../../../announce/announcer', () => ({ announce: vi.fn() }));

const ROLE = {
  id: 'r1',
  companyId: 'c1',
  slug: 'writer',
  name: 'Writer',
  description: 'Writes things.',
  rolePrompt: 'Be brief.',
  knowledgeDomains: ['docs'],
  mcpServerList: [],
  queryIndex: 0,
  llmConfig: { provider: 'openai-compatible', model: 'm', apiKey: '***' },
};

const SERVERS = [
  { name: 'storage', usage: 'Keeps files.', available: true },
  { name: 'records', usage: 'Keeps tables.', available: false },
];

const COMPANY = {
  id: 'c1',
  slug: 'acme',
  mcpServerToggles: { records: false },
};

const routes = (role: object = ROLE, company: object | null = COMPANY) =>
  [
    [/\/api\/company\/c1\/roles$/, { body: [role] }],
    [/\/api\/company\/c1$/, { body: company }],
    [/\/api\/mcp-servers$/, { body: SERVERS }],
    [/\/api\/role\/r1$/, { body: ROLE }],
    [
      /\/api\/role$/,
      { status: 201, body: { ...ROLE, id: 'r9', name: 'Cook' } },
    ],
  ] as const;

const render_ = (roleId: string | null) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RoleDialog companyId="c1" roleId={roleId} onClose={vi.fn()} />
    </QueryClientProvider>,
  );

/** The bodies of the POST and PUT requests made so far. */
const sentBodies = async (): Promise<unknown[]> => {
  const writes = fetchMock.mock.calls
    .map(([input]) => input)
    .filter(
      (input): input is Request =>
        input instanceof Request && ['POST', 'PUT'].includes(input.method),
    );
  return Promise.all(writes.map((request) => request.clone().json()));
};

describe('RoleDialog', () => {
  beforeEach(() => {
    installFetchMock();
    respondByRoute([...routes()]);
    vi.mocked(announce).mockClear();
  });

  describe('adding', () => {
    it('follows the name with the slug, sends only chosen toggles, then becomes the saved role', async () => {
      const user = userEvent.setup();
      fetchMock.mockImplementation((input) => {
        const request = input instanceof Request ? input : null;
        const url = input instanceof Request ? input.url : input.toString();
        const json = (status: number, body: unknown, headers = {}) =>
          Promise.resolve(
            new Response(JSON.stringify(body), {
              status,
              headers: { 'Content-Type': 'application/json', ...headers },
            }),
          );
        if (request?.method === 'POST') {
          return json(
            201,
            { ...ROLE, id: 'r9', name: 'Cook' },
            {
              'X-Tcp-Warnings': JSON.stringify([
                encodeURIComponent('No knowledge domains.'),
              ]),
            },
          );
        }
        if (/\/mcp-servers$/.test(url)) return json(200, SERVERS);
        if (/\/c1\/roles$/.test(url)) return json(200, []);
        return json(200, COMPANY);
      });
      render_(null);

      expect(
        await screen.findByRole('heading', {
          name: t('admin.role.newHeading'),
        }),
      ).toBeInTheDocument();
      await user.type(
        screen.getByRole('textbox', { name: /^Name/ }),
        'Head Cook',
      );
      expect(screen.getByRole('textbox', { name: /^Slug/ })).toHaveValue(
        'head-cook',
      );
      await user.type(
        screen.getByRole('textbox', { name: /^Description/ }),
        'Cooks.',
      );
      const storage = await screen.findByRole('radiogroup', {
        name: 'storage',
      });
      await user.click(within(storage).getByRole('radio', { name: 'Off' }));
      await user.click(
        screen.getByRole('button', { name: t('admin.role.create') }),
      );

      expect(
        await screen.findByText('No knowledge domains.'),
      ).toBeInTheDocument();
      expect(await sentBodies()).toEqual([
        {
          companyId: 'c1',
          slug: 'head-cook',
          name: 'Head Cook',
          description: 'Cooks.',
          rolePrompt: '',
          knowledgeDomains: [],
          mcpServerList: [],
          mcpServerToggles: { storage: false },
        },
      ]);
      expect(screen.getByRole('heading', { name: 'Cook' })).toBeInTheDocument();
      expect(
        screen.getByRole('tab', { name: t('admin.role.tab.knowledge') }),
      ).toBeEnabled();
      expect(announce).toHaveBeenCalledWith({
        channel: 'role-dialog',
        change: 'admin.role.announce.created',
        params: { name: 'Cook' },
      });
    });

    it('refuses the slug "shared" before any request', async () => {
      const user = userEvent.setup();
      render_(null);
      await user.type(
        await screen.findByRole('textbox', { name: /^Name/ }),
        'x',
      );
      await user.type(
        screen.getByRole('textbox', { name: /^Description/ }),
        'd',
      );
      const slug = screen.getByRole('textbox', { name: /^Slug/ });
      await user.clear(slug);
      await user.type(slug, 'shared');
      await user.click(
        screen.getByRole('button', { name: t('admin.role.create') }),
      );

      expect(slug).toHaveAccessibleDescription(
        expect.stringContaining(t('admin.role.slugReserved')),
      );
      expect(await sentBodies()).toEqual([]);
    });

    it('shows a missing name on the field', async () => {
      const user = userEvent.setup();
      render_(null);
      await user.click(
        await screen.findByRole('button', { name: t('admin.role.create') }),
      );
      expect(
        screen.getByRole('textbox', { name: /^Name/ }),
      ).toHaveAccessibleDescription(
        expect.stringContaining(t('admin.role.nameRequired')),
      );
      expect(await sentBodies()).toEqual([]);
    });

    it('disables the Knowledge tab and says why', async () => {
      render_(null);
      expect(
        await screen.findByRole('tab', { name: t('admin.role.tab.knowledge') }),
      ).toHaveAttribute('aria-disabled', 'true');
      expect(
        screen.getByText(t('admin.role.knowledgeDisabled')),
      ).toBeInTheDocument();
    });

    it('shows a server 400', async () => {
      const user = userEvent.setup();
      const base = fetchMock.getMockImplementation();
      fetchMock.mockImplementation((input, init) =>
        input instanceof Request && input.method === 'POST'
          ? Promise.resolve(
              new Response(JSON.stringify({ message: 'slug taken' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
              }),
            )
          : (base?.(input, init) ?? Promise.reject(new Error('no fetch'))),
      );
      render_(null);
      await user.type(
        await screen.findByRole('textbox', { name: /^Name/ }),
        'Cook',
      );
      await user.type(
        screen.getByRole('textbox', { name: /^Description/ }),
        'd',
      );
      await user.click(
        screen.getByRole('button', { name: t('admin.role.create') }),
      );
      expect(await screen.findByText('slug taken')).toBeInTheDocument();
    });
  });

  describe('editing', () => {
    it('sends only the changed field, and never the api key', async () => {
      const user = userEvent.setup();
      render_('r1');
      const description = await screen.findByRole('textbox', {
        name: /^Description/,
      });
      expect(screen.queryByRole('textbox', { name: /^Slug/ })).toBeNull();
      expect(
        screen.getByRole('tab', { name: t('admin.role.tab.knowledge') }),
      ).toBeEnabled();
      await user.type(description, ' More.');
      await user.click(
        screen.getByRole('button', { name: t('admin.role.save') }),
      );

      await waitFor(() => expect(announce).toHaveBeenCalled());
      const bodies = await sentBodies();
      expect(bodies).toEqual([{ description: 'Writes things. More.' }]);
      expect(JSON.stringify(bodies)).not.toContain('apiKey');
    });

    it.each([
      ['On', { storage: true }],
      ['Off', { storage: false }],
    ])('maps the %s choice to the toggle', async (label, toggles) => {
      const user = userEvent.setup();
      render_('r1');
      const group = await screen.findByRole('radiogroup', { name: 'storage' });
      await user.click(within(group).getByRole('radio', { name: label }));
      await user.click(
        screen.getByRole('button', { name: t('admin.role.save') }),
      );
      await waitFor(() => expect(announce).toHaveBeenCalled());
      expect(await sentBodies()).toEqual([{ mcpServerToggles: toggles }]);
    });

    it('maps back to the company default by leaving the key out', async () => {
      const user = userEvent.setup();
      respondByRoute([
        ...routes({
          ...ROLE,
          mcpServerToggles: { storage: true },
        }),
      ]);
      render_('r1');
      const group = await screen.findByRole('radiogroup', { name: 'storage' });
      expect(within(group).getByRole('radio', { name: 'On' })).toBeChecked();
      await user.click(
        within(group).getByRole('radio', {
          name: t('admin.role.mcp.defaultOn'),
        }),
      );
      await user.click(
        screen.getByRole('button', { name: t('admin.role.save') }),
      );
      await waitFor(() => expect(announce).toHaveBeenCalled());
      expect(await sentBodies()).toEqual([{ mcpServerToggles: null }]);
    });

    it('labels the catalogue: unavailable servers and the company default', async () => {
      render_('r1');
      expect(
        await screen.findByRole('radiogroup', {
          name: t('admin.role.mcp.unavailable', { name: 'records' }),
        }),
      ).toBeInTheDocument();
      const records = screen.getByRole('radiogroup', {
        name: t('admin.role.mcp.unavailable', { name: 'records' }),
      });
      expect(
        within(records).getByRole('radio', {
          name: t('admin.role.mcp.defaultOff'),
        }),
      ).toBeInTheDocument();
    });

    it('says which model applies, and drops the role’s own on request', async () => {
      const user = userEvent.setup();
      render_('r1');
      expect(
        await screen.findByText(
          t('admin.role.llm.role', {
            provider: 'openai-compatible',
            model: 'm',
          }),
        ),
      ).toBeInTheDocument();
      await user.click(
        screen.getByRole('button', { name: t('admin.role.llm.useCompany') }),
      );
      await waitFor(() => expect(announce).toHaveBeenCalled());
      expect(await sentBodies()).toEqual([{ llmConfig: null }]);
    });

    it('falls back to the company model, then the app default', async () => {
      const bare = { ...ROLE, llmConfig: null };
      respondByRoute([
        ...routes(bare, {
          ...COMPANY,
          llmConfig: { provider: 'p', model: 'cm' },
        }),
      ]);
      const view = render_('r1');
      expect(
        await screen.findByText(
          t('admin.role.llm.company', { provider: 'p', model: 'cm' }),
        ),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: t('admin.role.llm.useCompany') }),
      ).toBeNull();
      view.unmount();

      respondByRoute([...routes(bare)]);
      render_('r1');
      expect(
        await screen.findByText(t('admin.role.llm.app')),
      ).toBeInTheDocument();
    });

    it('has no accessibility violations', async () => {
      render_('r1');
      await screen.findByRole('radiogroup', { name: 'storage' });
      await expectNoA11yViolations(document.body);
    });
  });
});
