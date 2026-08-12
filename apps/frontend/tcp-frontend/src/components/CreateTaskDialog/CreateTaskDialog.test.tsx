import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, useState } from 'react';
import { Button } from 'react-aria-components';
import { beforeEach, describe, expect, it } from 'vitest';
import type { components } from '../../api/schema';
import { t } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import {
  fetchMock,
  installFetchMock,
  respondByRoute,
  type RouteResponse,
} from '../../test-support/fetch-mock';
import { CreateTaskDialog } from './CreateTaskDialog';

type Task = components['schemas']['TaskResponseDto'];
type Role = components['schemas']['RoleResponseDto'];

const COMPANY_ID = 'company-1';
const TASK_ID = 'task-1';
const NOW = '2026-08-10T09:00:00.000Z';

const CREATE_ROUTE = /\/api\/task$/;
const START_ROUTE = new RegExp(`/api/task/${TASK_ID}/start`);
const MATERIALS_ROUTE = new RegExp(`/api/task/${TASK_ID}/materials`);
const ROLES_ROUTE = new RegExp(`/api/company/${COMPANY_ID}/roles`);

const roleFixture = (id: string, name: string): Role => ({
  id,
  companyId: COMPANY_ID,
  slug: id,
  name,
  description: 'd',
  knowledgeDomains: [],
  mcpServerList: [],
  queryIndex: 0,
});

const ROLE_A = roleFixture('role-a', 'Sales');
const ROLE_B = roleFixture('role-b', 'Legal');

const taskFixture = (overrides: Partial<Task> = {}): Task => ({
  id: TASK_ID,
  companyId: COMPANY_ID,
  request: 'Reconcile Q3 accounts',
  shortcode: 'TASK-1',
  plannerRoleId: null,
  status: 'ready',
  materials: [],
  expected: [],
  completed: null,
  failureReason: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

interface CreateRoutes {
  readonly roles?: RouteResponse;
  readonly create?: RouteResponse;
  readonly start?: RouteResponse;
  readonly materials?: RouteResponse;
}

/** Answers every route this dialog can reach, each overridable. */
const respondCreateTask = (overrides: CreateRoutes = {}): void => {
  respondByRoute([
    [
      START_ROUTE,
      overrides.start ?? { body: taskFixture({ status: 'in-progress' }) },
    ],
    [MATERIALS_ROUTE, overrides.materials ?? { status: 200, body: undefined }],
    [CREATE_ROUTE, overrides.create ?? { body: taskFixture() }],
    [ROLES_ROUTE, overrides.roles ?? { body: [ROLE_A, ROLE_B] }],
  ]);
};

/**
 * A real, keyboard-reachable control that opens the dialog — so React Aria's
 * dialog has something to return focus to on close, and StrictMode's double
 * effect invocation is exercised the same way a real page would trigger it.
 */
const Opener = () => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        className="react-aria-Button"
        onPress={() => {
          setOpen(true);
        }}
      >
        Open
      </Button>
      {open && (
        <CreateTaskDialog
          companyId={COMPANY_ID}
          onClose={() => {
            setOpen(false);
          }}
        />
      )}
    </>
  );
};

const renderCreateTaskDialog = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    queryClient,
    ...render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <Opener />
        </QueryClientProvider>
      </StrictMode>,
    ),
  };
};

const openDialog = async (
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> => {
  await user.click(screen.getByRole('button', { name: 'Open' }));
  await screen.findByRole('dialog', { name: t('task.create.heading') });
};

const requestField = () =>
  screen.getByRole('textbox', { name: t('task.create.request.label') });

const submitButton = () =>
  screen.getByRole('button', { name: t('task.create.submit') });

/** Every request url made so far, in the order `fetch` saw them. */
const callUrls = (): string[] =>
  fetchMock.mock.calls.map(([input]) =>
    input instanceof Request ? input.url : String(input),
  );

const requestCount = (route: RegExp): number =>
  callUrls().filter((url) => route.test(url)).length;

/** The index of the first call matching `route`, or `-1` if there is none. */
const firstIndex = (urls: readonly string[], route: RegExp): number =>
  urls.findIndex((url) => route.test(url));

/** Every index whose call matches `route`. */
const allIndices = (urls: readonly string[], route: RegExp): number[] =>
  urls.reduce<number[]>((acc, url, index) => {
    if (route.test(url)) acc.push(index);
    return acc;
  }, []);

const jsonResponse = (status: number, body: unknown, headers?: HeadersInit) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

const fileFromMaterialsCall = (init?: RequestInit): File | null => {
  const body = init?.body;
  if (!(body instanceof FormData)) return null;
  const file = body.get('file');
  return file instanceof File ? file : null;
};

describe('CreateTaskDialog', () => {
  beforeEach(() => {
    installFetchMock();
  });

  it('makes every field reachable by role and accessible name', async () => {
    respondCreateTask();
    const user = userEvent.setup();
    renderCreateTaskDialog();
    await openDialog(user);

    expect(requestField()).toBeInTheDocument();
    expect(
      screen.getByLabelText(t('task.create.plannerRole.label')),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('option', { name: ROLE_A.name }),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(t('task.create.materials.label')),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: t('task.create.start.label') }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: t('task.create.expected.add') }),
    ).toBeInTheDocument();
    expect(submitButton()).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: t('task.create.discard') }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: t('task.create.expected.add') }),
    );
    expect(
      screen.getByRole('textbox', {
        name: t('task.create.expected.label', { position: 1 }),
      }),
    ).toBeInTheDocument();
  });

  describe('the native controls behind the eslint-disable', () => {
    // These two prove the accessible name resolves the way a screen reader
    // finds it — `getByLabelText` — which is exactly what justifies the
    // `jsx-a11y/control-has-associated-label` disable on the file input: the
    // rule cannot see a `t()` call as a literal, but this shows the label is
    // real regardless.
    it('finds the file input by its label text', async () => {
      respondCreateTask();
      const user = userEvent.setup();
      renderCreateTaskDialog();
      await openDialog(user);

      const fileInput = screen.getByLabelText(t('task.create.materials.label'));
      expect(fileInput).toHaveAttribute('type', 'file');
    });

    it('finds the planner-role select by its label text', async () => {
      respondCreateTask();
      const user = userEvent.setup();
      renderCreateTaskDialog();
      await openDialog(user);

      const roleSelect = screen.getByLabelText(
        t('task.create.plannerRole.label'),
      );
      expect(roleSelect.tagName).toBe('SELECT');
    });
  });

  describe('validation', () => {
    it('rejects an empty request, associates the error with the field, and focuses it', async () => {
      respondCreateTask();
      const user = userEvent.setup();
      renderCreateTaskDialog();
      await openDialog(user);

      await user.click(submitButton());

      const field = requestField();
      // The field also carries standing help text (`description`), which
      // React Aria concatenates ahead of the error in the one
      // `aria-describedby` — so the accessible description is both, not the
      // error alone.
      expect(field).toHaveAccessibleDescription(
        `${t('task.create.request.description')} ${t('task.create.request.required')}`,
      );
      expect(field).toHaveFocus();
      expect(requestCount(CREATE_ROUTE)).toBe(0);
    });

    it('rejects an empty expected-output row, associates the error, and focuses that row when the request is otherwise valid', async () => {
      respondCreateTask();
      const user = userEvent.setup();
      renderCreateTaskDialog();
      await openDialog(user);

      await user.type(requestField(), 'Reconcile the accounts');
      await user.click(
        screen.getByRole('button', { name: t('task.create.expected.add') }),
      );
      await user.click(submitButton());

      const row = screen.getByRole('textbox', {
        name: t('task.create.expected.label', { position: 1 }),
      });
      // Row 1 also carries the standing description, same reasoning as the
      // request field above.
      expect(row).toHaveAccessibleDescription(
        `${t('task.create.expected.description')} ${t('task.create.expected.required')}`,
      );
      expect(row).toHaveFocus();
      expect(requestCount(CREATE_ROUTE)).toBe(0);
    });

    it('focuses the request field first when both it and an expected row are invalid', async () => {
      respondCreateTask();
      const user = userEvent.setup();
      renderCreateTaskDialog();
      await openDialog(user);

      await user.click(
        screen.getByRole('button', { name: t('task.create.expected.add') }),
      );
      await user.click(submitButton());

      expect(requestField()).toHaveFocus();
    });
  });

  it('creates, then starts, in that order, when the start checkbox is on', async () => {
    respondCreateTask();
    const user = userEvent.setup();
    renderCreateTaskDialog();
    await openDialog(user);

    await user.type(requestField(), 'Reconcile the accounts');
    expect(
      screen.getByRole('checkbox', { name: t('task.create.start.label') }),
    ).toBeChecked();
    await user.click(submitButton());

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    const urls = callUrls();
    const createIndex = firstIndex(urls, CREATE_ROUTE);
    const startIndex = firstIndex(urls, START_ROUTE);
    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(startIndex).toBeGreaterThan(createIndex);
    expect(requestCount(MATERIALS_ROUTE)).toBe(0);
  });

  it('does not start the task when the start checkbox is off', async () => {
    respondCreateTask();
    const user = userEvent.setup();
    renderCreateTaskDialog();
    await openDialog(user);

    await user.type(requestField(), 'Reconcile the accounts');
    await user.click(
      screen.getByRole('checkbox', { name: t('task.create.start.label') }),
    );
    await user.click(submitButton());

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    expect(requestCount(CREATE_ROUTE)).toBe(1);
    expect(requestCount(START_ROUTE)).toBe(0);
  });

  it('uploads every selected file, one materials call each, then starts — in order', async () => {
    respondCreateTask();
    const user = userEvent.setup();
    renderCreateTaskDialog();
    await openDialog(user);

    await user.type(requestField(), 'Reconcile the accounts');
    const fileInput = screen.getByLabelText(t('task.create.materials.label'));
    const fileA = new File(['a'], 'a.txt', { type: 'text/plain' });
    const fileB = new File(['b'], 'b.txt', { type: 'text/plain' });
    await user.upload(fileInput, [fileA, fileB]);

    expect(screen.getByText('a.txt')).toBeInTheDocument();
    expect(screen.getByText('b.txt')).toBeInTheDocument();

    await user.click(submitButton());

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    const urls = callUrls();
    const createIndex = firstIndex(urls, CREATE_ROUTE);
    const materialsIndices = allIndices(urls, MATERIALS_ROUTE);
    const startIndex = firstIndex(urls, START_ROUTE);

    expect(materialsIndices).toHaveLength(2);
    expect(Math.min(...materialsIndices)).toBeGreaterThan(createIndex);
    expect(startIndex).toBeGreaterThan(Math.max(...materialsIndices));
  });

  it('reports one failing upload without starting, keeps the dialog open, and names the file', async () => {
    const fileA = new File(['a'], 'a.txt', { type: 'text/plain' });
    const fileB = new File(['b'], 'b.txt', { type: 'text/plain' });

    fetchMock.mockImplementation((input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (ROLES_ROUTE.test(url)) {
        return Promise.resolve(jsonResponse(200, [ROLE_A, ROLE_B]));
      }
      if (CREATE_ROUTE.test(url)) {
        return Promise.resolve(jsonResponse(200, taskFixture()));
      }
      if (MATERIALS_ROUTE.test(url)) {
        const file = fileFromMaterialsCall(init);
        if (file?.name === 'a.txt') {
          return Promise.resolve(
            jsonResponse(500, { message: 'upload failed' }),
          );
        }
        return Promise.resolve(jsonResponse(200, undefined));
      }
      if (START_ROUTE.test(url)) {
        return Promise.resolve(
          jsonResponse(200, taskFixture({ status: 'in-progress' })),
        );
      }
      throw new Error(`unexpected request to ${url}`);
    });

    const user = userEvent.setup();
    renderCreateTaskDialog();
    await openDialog(user);

    await user.type(requestField(), 'Reconcile the accounts');
    const fileInput = screen.getByLabelText(t('task.create.materials.label'));
    await user.upload(fileInput, [fileA, fileB]);
    await user.click(submitButton());

    expect(
      await screen.findByText(
        t('task.create.materials.failed', { filenames: 'a.txt' }),
      ),
    ).toBeInTheDocument();
    expect(requestCount(CREATE_ROUTE)).toBe(1);
    expect(requestCount(START_ROUTE)).toBe(0);
    expect(
      screen.getByRole('dialog', { name: t('task.create.heading') }),
    ).toBeInTheDocument();
  });

  it('shows the server rejection on a 400, and leaves the form usable', async () => {
    respondCreateTask({
      create: { status: 400, body: { message: 'nope, try again' } },
    });
    const user = userEvent.setup();
    renderCreateTaskDialog();
    await openDialog(user);

    await user.type(requestField(), 'Reconcile the accounts');
    await user.click(submitButton());

    expect(
      await screen.findByText(t('task.create.rejected')),
    ).toBeInTheDocument();

    const field = requestField();
    expect(field).toBeEnabled();
    await user.type(field, ' plus more detail');
    expect(field).toHaveValue('Reconcile the accounts plus more detail');
    expect(submitButton()).toBeEnabled();
  });

  it('renders decoded soft warnings from the X-Tcp-Warnings response header', async () => {
    fetchMock.mockImplementation((input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (ROLES_ROUTE.test(url)) return Promise.resolve(jsonResponse(200, []));
      if (CREATE_ROUTE.test(url)) {
        return Promise.resolve(
          jsonResponse(200, taskFixture(), {
            'X-Tcp-Warnings': JSON.stringify([
              encodeURIComponent('no planner role'),
            ]),
          }),
        );
      }
      return Promise.reject(new Error(`unexpected request to ${url}`));
    });

    const user = userEvent.setup();
    renderCreateTaskDialog();
    await openDialog(user);

    await user.type(requestField(), 'Reconcile the accounts');
    await user.click(
      screen.getByRole('checkbox', { name: t('task.create.start.label') }),
    );
    await user.click(submitButton());

    const group = await screen.findByRole('group', {
      name: t('task.create.warnings.label'),
    });
    expect(within(group).getByText('no planner role')).toBeInTheDocument();
    expect(
      screen.getByRole('dialog', { name: t('task.create.heading') }),
    ).toBeInTheDocument();
  });

  it('is completable by keyboard alone', async () => {
    respondCreateTask();
    const user = userEvent.setup();
    renderCreateTaskDialog();

    await user.tab();
    expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus();
    await user.keyboard('{Enter}');
    await screen.findByRole('dialog', { name: t('task.create.heading') });

    const field = requestField();
    for (let i = 0; i < 15 && document.activeElement !== field; i += 1) {
      await user.tab();
    }
    expect(field).toHaveFocus();
    await user.keyboard('Reconcile the accounts, keyboard-only');

    const submit = submitButton();
    for (let i = 0; i < 20 && document.activeElement !== submit; i += 1) {
      await user.tab();
    }
    expect(submit).toHaveFocus();
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(requestCount(CREATE_ROUTE)).toBe(1);
  });

  describe('accessibility', () => {
    it('has no violations on the empty form', async () => {
      respondCreateTask();
      const user = userEvent.setup();
      renderCreateTaskDialog();
      await openDialog(user);

      await expectNoA11yViolations(document.body);
    });

    it('has no violations with every validation error showing', async () => {
      respondCreateTask();
      const user = userEvent.setup();
      renderCreateTaskDialog();
      await openDialog(user);

      await user.click(
        screen.getByRole('button', { name: t('task.create.expected.add') }),
      );
      await user.click(submitButton());
      await screen.findByText(t('task.create.expected.required'));

      await expectNoA11yViolations(document.body);
    });
  });
});
