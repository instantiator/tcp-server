import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../../../strings';
import { expectNoA11yViolations } from '../../../../test-support/axe';
import type { CompanySnapshot } from '../rules/companySnapshot';
import type { HoverEvent } from '../TcpPhaserEventBus';
import { createInitialWorld } from '../world/layout';
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
      t('visualisation.tooltip.task', { step: 1, steps: 3 }),
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
