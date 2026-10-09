import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../../../strings';
import { expectNoA11yViolations } from '../../../../test-support/axe';
import type { CompanySnapshot } from '../rules/companySnapshot';
import type { HoverEvent } from '../TcpPhaserEventBus';
import { createInitialWorld } from '../world/layout';
import { addRoom } from '../world/worldOps';
import { VisualisationTooltip } from './VisualisationTooltip';

const WORLD = createInitialWorld();

const SNAPSHOT: CompanySnapshot = {
  roles: [{ id: 'role-1', name: 'Sales' }],
  tasks: [
    {
      id: 'task-1',
      shortcode: 'TASK-1',
      request: 'Reconcile accounts',
      finished: false,
      succeeded: false,
      status: 'in-progress',
      pausedAt: null,
      visualisationClosedAt: null,
      step: 1,
      steps: 3,
    },
  ],
  agents: [
    {
      id: 'agent-1',
      roleId: 'role-1',
      assignmentId: 'assign-1',
      taskId: 'task-1',
      status: 'running',
      activity: { kind: 'working' },
    },
  ],
};

const hoverOn = (target: HoverEvent['target'], x = 10, y = 20): HoverEvent => ({
  target,
  x,
  y,
});

describe('VisualisationTooltip', () => {
  it('renders nothing when hover is null', () => {
    const { container } = render(
      <VisualisationTooltip hover={null} snapshot={SNAPSHOT} world={WORLD} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the snapshot is null', () => {
    const { container } = render(
      <VisualisationTooltip
        world={WORLD}
        hover={hoverOn({ kind: 'role', id: 'role-1' })}
        snapshot={null}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the target is not in the snapshot', () => {
    const { container } = render(
      <VisualisationTooltip
        world={WORLD}
        hover={hoverOn({ kind: 'role', id: 'gone' })}
        snapshot={SNAPSHOT}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("shows a role's tooltip text", () => {
    render(
      <VisualisationTooltip
        world={WORLD}
        hover={hoverOn({ kind: 'role', id: 'role-1' })}
        snapshot={SNAPSHOT}
      />,
    );

    expect(screen.getByRole('tooltip')).toHaveTextContent(
      t('visualisation.tooltip.role', { role: 'Sales' }),
    );
  });

  it("shows an agent's tooltip text, naming its role", () => {
    render(
      <VisualisationTooltip
        world={WORLD}
        hover={hoverOn({ kind: 'agent', id: 'agent-1' })}
        snapshot={SNAPSHOT}
      />,
    );

    expect(screen.getByRole('tooltip')).toHaveTextContent(
      t('visualisation.tooltip.agent', { role: 'Sales' }),
    );
  });

  it('reads "Task completed" over the completed tick', () => {
    render(
      <VisualisationTooltip
        world={WORLD}
        hover={hoverOn({ kind: 'completed', id: 'task-1' })}
        snapshot={SNAPSHOT}
      />,
    );

    expect(screen.getByRole('tooltip')).toHaveTextContent('Task completed');
  });

  it("shows a task's step count and its request", () => {
    render(
      <VisualisationTooltip
        world={WORLD}
        hover={hoverOn({ kind: 'task', id: 'task-1' })}
        snapshot={SNAPSHOT}
      />,
    );

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent(
      t('visualisation.tooltip.task', {
        shortcode: 'TASK-1',
        step: 1,
        steps: 3,
      }),
    );
    expect(tooltip).toHaveTextContent('Reconcile accounts');
  });

  it("shows a doorway's room title and what the room is for", () => {
    render(
      <VisualisationTooltip
        world={WORLD}
        hover={hoverOn({ kind: 'room', id: 'mail' })}
        snapshot={SNAPSHOT}
      />,
    );

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent(t('visualisation.room.mail'));
    expect(tooltip).toHaveTextContent(t('visualisation.room.mail.description'));
  });

  it("shows a piece of furniture's title and purpose", () => {
    const pigeonholes = WORLD.furniture.find(
      (item) => item.kind === 'pigeonholes',
    );
    render(
      <VisualisationTooltip
        world={WORLD}
        hover={hoverOn({ kind: 'furniture', id: pigeonholes?.id ?? '' })}
        snapshot={SNAPSHOT}
      />,
    );

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent(t('visualisation.furniture.pigeonholes'));
    expect(tooltip).toHaveTextContent(
      t('visualisation.furniture.pigeonholes.description'),
    );
  });

  it("shows the archive bookshelf's furniture description on hover, same as before it became selectable", () => {
    render(
      <VisualisationTooltip
        world={WORLD}
        hover={hoverOn({ kind: 'archive' })}
        snapshot={SNAPSHOT}
      />,
    );

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent(
      t('visualisation.furniture.bookshelf', { count: 0 }),
    );
    expect(tooltip).toHaveTextContent(
      t('visualisation.furniture.bookshelf.description'),
    );
  });

  it('counts the succeeded tasks in the bookshelf title', () => {
    const [first] = SNAPSHOT.tasks;
    if (first === undefined) throw new Error('fixture has no task');
    render(
      <VisualisationTooltip
        world={WORLD}
        hover={hoverOn({ kind: 'archive' })}
        snapshot={{
          ...SNAPSHOT,
          tasks: [
            first,
            { ...first, id: 'a', finished: true, succeeded: true },
            { ...first, id: 'b', finished: true, succeeded: true },
            { ...first, id: 'c', finished: true },
          ],
        }}
      />,
    );

    expect(screen.getByRole('tooltip')).toHaveTextContent('Bookshelf: 2');
  });

  it("shows a task room's request below its description", () => {
    render(
      <VisualisationTooltip
        world={addRoom(WORLD, 'task', 'task:task-1', 'task-1')}
        hover={hoverOn({ kind: 'room', id: 'task:task-1' })}
        snapshot={SNAPSHOT}
      />,
    );

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('Task room: TASK-1');
    expect(tooltip).toHaveTextContent('Agents work on task TASK-1 here.');
    expect(tooltip.querySelectorAll('p')[1]).toHaveTextContent(
      'Reconcile accounts',
    );
  });

  it('renders nothing for furniture that has gone', () => {
    const { container } = render(
      <VisualisationTooltip
        world={WORLD}
        hover={hoverOn({ kind: 'furniture', id: 'gone' })}
        snapshot={SNAPSHOT}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('has no accessibility violations while describing furniture', async () => {
    const { container } = render(
      <VisualisationTooltip
        world={WORLD}
        hover={hoverOn({ kind: 'room', id: 'rec' })}
        snapshot={SNAPSHOT}
      />,
    );

    await expectNoA11yViolations(container);
  });

  it('is positioned at the pointer', () => {
    render(
      <VisualisationTooltip
        world={WORLD}
        hover={hoverOn({ kind: 'role', id: 'role-1' }, 42, 99)}
        snapshot={SNAPSHOT}
      />,
    );

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.style.left).toBe('42px');
    expect(tooltip.style.top).toBe('99px');
  });

  it('has no accessibility violations while shown', async () => {
    const { container } = render(
      <VisualisationTooltip
        world={WORLD}
        hover={hoverOn({ kind: 'task', id: 'task-1' })}
        snapshot={SNAPSHOT}
      />,
    );

    await expectNoA11yViolations(container);
  });
});
