import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installFetchMock,
  respondByRoute,
} from '../../../test-support/fetch-mock';
import { TasksList } from './TasksList';

// The dialog has its own tests; here only whether this list opens it, and on
// which task, is in question.
vi.mock('../../../components/TaskDialog/TaskDialog', () => ({
  TaskDialog: ({
    taskId,
    onClose,
  }: {
    readonly taskId: string;
    readonly onClose: () => void;
  }) => (
    <div role="dialog" aria-label={`dialog for ${taskId}`}>
      <button type="button" onClick={onClose}>
        close
      </button>
    </div>
  ),
}));

const COMPANY_ID = 'company-1';

const SearchProbe = () => <p data-testid="search">{useLocation().search}</p>;

const renderTasks = (path: string) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={[path]}>
        <SearchProbe />
        <TasksList companyId={COMPANY_ID} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('TasksList deep link from a notification', () => {
  beforeEach(() => {
    installFetchMock();
    respondByRoute([[/\/api\/task\?/, { body: [] }]]);
  });

  it('opens the dialog for the task the URL names, and drops the param on close', async () => {
    const user = userEvent.setup();
    renderTasks('/?task=task-9');

    expect(
      await screen.findByRole('dialog', { name: 'dialog for task-9' }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'close' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('search')).toHaveTextContent('');
  });

  it('opens nothing without the param', async () => {
    renderTasks('/');

    await screen.findByRole('region');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
