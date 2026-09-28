import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { t } from '../../../../strings';
import { expectNoA11yViolations } from '../../../../test-support/axe';
import type { CompanySnapshot } from '../rules/companySnapshot';
import { DetailsPicker } from './DetailsPicker';

const SNAPSHOT: CompanySnapshot = {
  roles: [
    { id: 'role-1', name: 'Sales' },
    { id: 'role-2', name: 'Legal' },
  ],
  tasks: [
    {
      id: 'task-1',
      shortcode: 'TASK-1',
      request: 'Reconcile accounts',
      finished: false,
      succeeded: false,
      step: 1,
      steps: 2,
    },
    {
      id: 'task-2',
      shortcode: 'TASK-2',
      request: 'Archive old records',
      finished: true,
      succeeded: true,
      step: 2,
      steps: 2,
    },
  ],
  agents: [
    {
      id: 'agent-1',
      roleId: 'role-1',
      assignmentId: 'assign-1',
      taskId: 'task-1',
      activity: { kind: 'working' },
    },
    {
      id: 'agent-2',
      roleId: 'role-2',
      assignmentId: 'assign-2',
      taskId: null,
      activity: { kind: 'messagingUser' },
    },
    {
      id: 'agent-3',
      roleId: 'role-1',
      assignmentId: 'assign-3',
      taskId: 'task-2',
      activity: { kind: 'finished' },
    },
  ],
};

const pickerButton = () =>
  screen.getByRole('button', {
    name: new RegExp(t('visualisation.picker.label')),
  });

const openPicker = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(pickerButton());
};

describe('DetailsPicker', () => {
  it('lists every role', async () => {
    const user = userEvent.setup();
    render(
      <DetailsPicker snapshot={SNAPSHOT} selection={null} onSelect={vi.fn()} />,
    );
    await openPicker(user);

    expect(
      screen.getByRole('option', {
        name: t('visualisation.picker.role', { name: 'Sales' }),
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', {
        name: t('visualisation.picker.role', { name: 'Legal' }),
      }),
    ).toBeInTheDocument();
  });

  it('lists only unfinished tasks', async () => {
    const user = userEvent.setup();
    render(
      <DetailsPicker snapshot={SNAPSHOT} selection={null} onSelect={vi.fn()} />,
    );
    await openPicker(user);

    expect(
      screen.getByRole('option', {
        name: t('visualisation.picker.task', { shortcode: 'TASK-1' }),
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('option', {
        name: t('visualisation.picker.task', { shortcode: 'TASK-2' }),
      }),
    ).toBeNull();
  });

  it('lists only agents whose activity is not finished, naming the task when it has one', async () => {
    const user = userEvent.setup();
    render(
      <DetailsPicker snapshot={SNAPSHOT} selection={null} onSelect={vi.fn()} />,
    );
    await openPicker(user);

    expect(
      screen.getByRole('option', {
        name: t('visualisation.picker.agentWithTask', {
          role: 'Sales',
          shortcode: 'TASK-1',
        }),
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', {
        name: t('visualisation.picker.agent', { role: 'Legal' }),
      }),
    ).toBeInTheDocument();
    // 2 roles + 1 unfinished task + 2 non-finished agents + 1 archive:
    // agent-3 has finished and must not appear at all, under either wording.
    expect(screen.getAllByRole('option')).toHaveLength(6);
  });

  it('always lists the Archive item, since there is only ever one archive', async () => {
    const user = userEvent.setup();
    render(
      <DetailsPicker snapshot={SNAPSHOT} selection={null} onSelect={vi.fn()} />,
    );
    await openPicker(user);

    expect(
      screen.getByRole('option', { name: t('visualisation.picker.archive') }),
    ).toBeInTheDocument();
  });

  it('calls onSelect with the chosen role', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <DetailsPicker
        snapshot={SNAPSHOT}
        selection={null}
        onSelect={onSelect}
      />,
    );
    await openPicker(user);

    await user.click(
      screen.getByRole('option', {
        name: t('visualisation.picker.role', { name: 'Sales' }),
      }),
    );

    expect(onSelect).toHaveBeenCalledWith({ kind: 'role', id: 'role-1' });
  });

  it('calls onSelect with the chosen task', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <DetailsPicker
        snapshot={SNAPSHOT}
        selection={null}
        onSelect={onSelect}
      />,
    );
    await openPicker(user);

    await user.click(
      screen.getByRole('option', {
        name: t('visualisation.picker.task', { shortcode: 'TASK-1' }),
      }),
    );

    expect(onSelect).toHaveBeenCalledWith({ kind: 'task', id: 'task-1' });
  });

  it('calls onSelect with the chosen agent', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <DetailsPicker
        snapshot={SNAPSHOT}
        selection={null}
        onSelect={onSelect}
      />,
    );
    await openPicker(user);

    await user.click(
      screen.getByRole('option', {
        name: t('visualisation.picker.agent', { role: 'Legal' }),
      }),
    );

    expect(onSelect).toHaveBeenCalledWith({ kind: 'agent', id: 'agent-2' });
  });

  it('calls onSelect with the archive target', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <DetailsPicker
        snapshot={SNAPSHOT}
        selection={null}
        onSelect={onSelect}
      />,
    );
    await openPicker(user);

    await user.click(
      screen.getByRole('option', { name: t('visualisation.picker.archive') }),
    );

    expect(onSelect).toHaveBeenCalledWith({ kind: 'archive' });
  });

  it('is disabled with no snapshot', () => {
    render(
      <DetailsPicker snapshot={null} selection={null} onSelect={vi.fn()} />,
    );

    expect(pickerButton()).toBeDisabled();
  });

  // Deliberate change (002.02 stage 9): the archive is now always in the
  // list — the archive room always exists, unlike a role, a task or an
  // agent — so an otherwise-empty snapshot no longer leaves the picker with
  // nothing to offer. Only a `null` snapshot (still loading) disables it.
  it('is enabled with the Archive item even when the snapshot has no other items', async () => {
    const user = userEvent.setup();
    render(
      <DetailsPicker
        snapshot={{ roles: [], tasks: [], agents: [] }}
        selection={null}
        onSelect={vi.fn()}
      />,
    );

    expect(pickerButton()).not.toBeDisabled();
    await openPicker(user);
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(
      screen.getByRole('option', { name: t('visualisation.picker.archive') }),
    ).toBeInTheDocument();
  });

  it('has no accessibility violations with the popover open', async () => {
    const user = userEvent.setup();
    render(
      <DetailsPicker snapshot={SNAPSHOT} selection={null} onSelect={vi.fn()} />,
    );
    await openPicker(user);

    // document.body, not container: React Aria's Popover portals the listbox
    // out of the render container, so scanning container would examine a
    // tree with no options in it and pass vacuously.
    await expectNoA11yViolations(document.body);
  });
});
