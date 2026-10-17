import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { announce } from '../../announce/announcer';
import type { TemplateSourceDTO } from '../../api/dtos';
import { t } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import { fetchMock, installFetchMock } from '../../test-support/fetch-mock';
import { TemplateSourcesDialog } from './TemplateSourcesDialog';

vi.mock('../../announce/announcer', () => ({ announce: vi.fn() }));

const SOURCES: TemplateSourceDTO[] = [
  { id: 'builtin', name: 'Built-in', location: 'bundled', origin: 'builtin' },
  { id: 'cfg', name: 'From config', location: 'acme/cfg', origin: 'config' },
  { id: 'u1', name: 'Mine', location: 'me/templates', origin: 'user' },
];

/** What the fake server holds and how it answers a POST. */
interface World {
  sources: TemplateSourceDTO[];
  addStatus: number;
}

let world: World;

const json = (body: unknown, status = 200) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** Every request as `METHOD path`. */
const calls: string[] = [];
const posted: unknown[] = [];

const serve = () => {
  fetchMock.mockImplementation(async (input) => {
    const request = input instanceof Request ? input : null;
    const method = request?.method ?? 'GET';
    const path = new URL(
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input,
    ).pathname;
    calls.push(`${method} ${path}`);
    if (method === 'POST') {
      const body: unknown = await request?.clone().json();
      posted.push(body);
      return world.addStatus === 201
        ? json({ id: 'u2', location: 'x/y', origin: 'user', name: 'New' }, 201)
        : json({ message: 'No such repository.' }, world.addStatus);
    }
    if (method === 'DELETE') return json(undefined, 204);
    return json(world.sources);
  });
};

const renderDialog = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TemplateSourcesDialog onClose={vi.fn()} />
    </QueryClientProvider>,
  );

type User = ReturnType<typeof userEvent.setup>;

const fill = async (user: User, label: string, text: string) => {
  await user.type(
    screen.getByRole('textbox', { name: new RegExp(`^${label}`) }),
    text,
  );
};

const submit = (user: User) =>
  user.click(
    screen.getByRole('button', {
      name: t('system.templateSources.add.submit'),
    }),
  );

describe('TemplateSourcesDialog', () => {
  beforeEach(() => {
    installFetchMock();
    calls.length = 0;
    posted.length = 0;
    vi.mocked(announce).mockClear();
    world = { sources: SOURCES, addStatus: 201 };
    serve();
  });

  it('lists each source with a plain label for where it came from', async () => {
    renderDialog();
    expect(await screen.findByText('Mine')).toBeVisible();
    expect(
      screen.getByText(t('system.templateSources.origin.builtin'), {
        exact: false,
      }),
    ).toBeVisible();
    expect(
      screen.getByText(t('system.templateSources.origin.config'), {
        exact: false,
      }),
    ).toBeVisible();
    expect(
      screen.getByText(t('system.templateSources.origin.user'), {
        exact: false,
      }),
    ).toBeVisible();
    expect(screen.getByText(/acme\/cfg/)).toBeVisible();
    await expectNoA11yViolations(document.body);
  });

  it('offers Remove only for a source added here, named after it', async () => {
    renderDialog();
    await screen.findByText('Mine');
    const buttons = screen.getAllByRole('button', { name: /^Remove / });
    expect(buttons.map((b) => b.textContent)).toEqual([
      t('system.templateSources.remove', { name: 'Mine' }),
    ]);
  });

  it('asks first, then removes, announces it and refetches', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(
      await screen.findByRole('button', {
        name: t('system.templateSources.remove', { name: 'Mine' }),
      }),
    );
    const confirm = await screen.findByRole('alertdialog', {
      name: t('system.templateSources.removeHeading', { name: 'Mine' }),
    });
    expect(
      within(confirm).getByText(t('system.templateSources.removeMessage')),
    ).toBeVisible();
    expect(calls).not.toContain('DELETE /api/template-source/u1');

    world.sources = SOURCES.slice(0, 2);
    await user.click(
      within(confirm).getByRole('button', {
        name: t('system.templateSources.removeConfirm'),
      }),
    );

    await waitFor(() =>
      expect(announce).toHaveBeenCalledWith({
        channel: 'template-sources',
        change: 'system.templateSources.announce.removed',
        params: { name: 'Mine' },
      }),
    );
    expect(calls).toContain('DELETE /api/template-source/u1');
    await waitFor(() => expect(screen.queryByText('Mine')).toBeNull());
  });

  it('removes nothing when the question is answered no', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(
      await screen.findByRole('button', {
        name: t('system.templateSources.remove', { name: 'Mine' }),
      }),
    );
    await user.click(
      await screen.findByRole('button', { name: t('confirm.no') }),
    );
    expect(calls.some((call) => call.startsWith('DELETE'))).toBe(false);
  });

  it('checks owner/repo before sending anything', async () => {
    const user = userEvent.setup();
    renderDialog();
    await screen.findByText('Mine');
    await fill(user, t('system.templateSources.add.name'), 'New');
    await fill(user, t('system.templateSources.add.repo'), 'not a repo');
    await submit(user);

    expect(
      await screen.findByText(t('system.templateSources.add.repoInvalid')),
    ).toBeVisible();
    expect(posted).toEqual([]);
    expect(
      screen.getByRole('textbox', {
        name: new RegExp(`^${t('system.templateSources.add.repo')}`),
      }),
    ).toHaveFocus();
  });

  it('sends the optional fields only when filled, then clears the form and announces', async () => {
    const user = userEvent.setup();
    renderDialog();
    await screen.findByText('Mine');
    await fill(user, t('system.templateSources.add.name'), 'New');
    await fill(user, t('system.templateSources.add.repo'), 'acme/templates');
    await fill(user, t('system.templateSources.add.path'), 'companies');
    await submit(user);

    await waitFor(() =>
      expect(announce).toHaveBeenCalledWith({
        channel: 'template-sources',
        change: 'system.templateSources.announce.added',
        params: { name: 'New' },
      }),
    );
    expect(posted).toEqual([
      { name: 'New', repo: 'acme/templates', path: 'companies' },
    ]);
    expect(
      screen.getByRole('textbox', {
        name: new RegExp(`^${t('system.templateSources.add.name')}`),
      }),
    ).toHaveValue('');
  });

  it('says so when the source is already listed', async () => {
    world.addStatus = 409;
    const user = userEvent.setup();
    renderDialog();
    await screen.findByText('Mine');
    await fill(user, t('system.templateSources.add.name'), 'Mine');
    await fill(user, t('system.templateSources.add.repo'), 'me/templates');
    await submit(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      t('system.templateSources.add.duplicate'),
    );
    expect(announce).not.toHaveBeenCalled();
  });

  it('shows the server’s message for a bad repository', async () => {
    world.addStatus = 400;
    const user = userEvent.setup();
    renderDialog();
    await screen.findByText('Mine');
    await fill(user, t('system.templateSources.add.name'), 'New');
    await fill(user, t('system.templateSources.add.repo'), 'acme/missing');
    await submit(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No such repository.',
    );
  });
});
