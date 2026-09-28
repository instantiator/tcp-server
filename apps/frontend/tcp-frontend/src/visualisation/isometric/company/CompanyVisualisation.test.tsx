import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WireEvent } from '@tcp/shared/client';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { statusLabel } from '../../../api/statuses';
import { applyEvent } from '../../../events/cache';
import { ChatContext } from '../../../components/ChatDialog/useChat';
import { t } from '../../../strings';
import { expectNoA11yViolations } from '../../../test-support/axe';
import {
  installFetchMock,
  respondByRoute,
} from '../../../test-support/fetch-mock';
import CompanyVisualisation from './CompanyVisualisation';
import { emitTcpEvent, offTcpEvent, onTcpEvent } from './TcpPhaserEventBus';
import { PAN_STEP_PX } from './ui/VisualisationToolbar';

// `phaser` is mocked globally in `test-setup.ts` — real Phaser cannot even be
// imported under jsdom. This suite only needs the real, unmocked
// `TcpPhaserEventBus` and office model underneath that mock: the tests below
// emit and listen on the bus exactly as the scene would, and check what
// `CompanyVisualisation` builds from the fetched roles, tasks, assignments
// and agents underneath it.

const COMPANY_ID = 'company-1';
const NOW = '2026-09-01T00:00:00.000Z';

const ROLES_ROUTE = /\/api\/company\/[^/]+\/roles/;
const AGENT_ROUTE = /\/api\/agent\/agent-1(\?|$)/;
const AGENTS_ROUTE = /\/api\/agent\?/;
const TASKS_ROUTE = /\/api\/task\?/;
const ASSIGNMENTS_ROUTE = /\/api\/assignment\?/;
const CONVERSATIONS_ROUTE = /\/api\/conversation\?/;

/**
 * `emitTcpEvent` always forwards its (usually absent) `context` as a second
 * positional argument, so a raw bus listener sees `(value, undefined)` rather
 * than just `(value)`. This reads only the value, so a test asserting on it
 * isn't coupled to that.
 */
const lastValue = (spy: ReturnType<typeof vi.fn>): unknown =>
  spy.mock.calls.at(-1)?.[0];

const renderCompanyVisualisation = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <ChatContext.Provider
        value={{ openChat: vi.fn(), closeChat: vi.fn(), startChat: vi.fn() }}
      >
        <CompanyVisualisation companyId={COMPANY_ID} />
      </ChatContext.Provider>
    </QueryClientProvider>,
  );
  return { ...utils, queryClient };
};

describe('CompanyVisualisation', () => {
  describe('the office summary', () => {
    const ROLES = [
      { id: 'role-1', name: 'Engineer' },
      { id: 'role-2', name: 'Reviewer' },
    ];

    beforeEach(() => {
      installFetchMock();
      respondByRoute([
        [ROLES_ROUTE, { body: ROLES }],
        [AGENTS_ROUTE, { body: [] }],
        [TASKS_ROUTE, { body: [] }],
        [ASSIGNMENTS_ROUTE, { body: [] }],
        [CONVERSATIONS_ROUTE, { body: [] }],
      ]);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('renders the office stage, described by the roles, task rooms and agents it holds', async () => {
      renderCompanyVisualisation();

      const stage = await screen.findByRole('group', {
        name: t('visualisation.stage.label'),
      });

      // The two roles arrive asynchronously and only then turn into avatars,
      // so the description starts at zero and has to be awaited separately
      // from finding the stage itself. `aria-describedby` now names both the
      // summary and the keyboard-keys help, so the accessible description is
      // their text joined with a space (the accname spec's rule for multiple
      // referenced elements).
      await waitFor(() =>
        expect(stage).toHaveAccessibleDescription(
          `${t('visualisation.summary', { roles: 2, taskRooms: 0, agents: 0 })} ${t('visualisation.keys')}`,
        ),
      );
    });

    it('has no accessibility violations', async () => {
      const { container } = renderCompanyVisualisation();

      await screen.findByRole('group', {
        name: t('visualisation.stage.label'),
      });
      await expectNoA11yViolations(container);
    });

    it('starts with the full-screen toggle unpressed', async () => {
      // A real regression: the hook once read an empty first-render ref as
      // "this element is fullscreen", so the toggle loaded pressed. jsdom
      // leaves `fullscreenElement` undefined, which hid it; a real browser
      // reports null, so this sets that up.
      Object.defineProperty(document, 'fullscreenElement', {
        value: null,
        configurable: true,
      });
      try {
        renderCompanyVisualisation();

        expect(
          await screen.findByRole('button', {
            name: t('visualisation.fullscreen'),
          }),
        ).toHaveAttribute('aria-pressed', 'false');
      } finally {
        Reflect.deleteProperty(document, 'fullscreenElement');
      }
    });
  });

  describe('interaction', () => {
    const ROLE_ID = 'role-1';
    const ROLE_NAME = 'Engineer';
    const TASK_ID = 'task-1';
    const TASK_SHORTCODE = 'TASK-1';
    const ASSIGNMENT_ID = 'assign-1';
    const AGENT_ID = 'agent-1';

    const roleFixture = () => ({
      id: ROLE_ID,
      companyId: COMPANY_ID,
      slug: 'engineer',
      name: ROLE_NAME,
      description: 'Builds things',
      knowledgeDomains: [],
      mcpServerList: [],
      queryIndex: 0,
    });

    const agentFixture = (status = 'running') => ({
      id: AGENT_ID,
      companyId: COMPANY_ID,
      roleId: ROLE_ID,
      assignmentId: ASSIGNMENT_ID,
      status,
      threadId: null,
      initialPrompt: 'go',
      createdAt: NOW,
      output: null,
      updatedAt: NOW,
    });

    const assignmentFixture = (status = 'in-progress') => ({
      id: ASSIGNMENT_ID,
      taskId: TASK_ID,
      companyId: COMPANY_ID,
      mode: 'implement',
      orderIndex: 0,
      prompt: 'Reconcile the Q3 accounts',
      shortcode: 'A1',
      roleId: ROLE_ID,
      status,
      failureReason: null,
      agentId: AGENT_ID,
      targetAssignmentId: null,
      parentAssignmentId: null,
      materials: [],
      expected: [],
      prepared: [],
      approved: [],
      summary: null,
      qaStatus: null,
      qaFeedback: null,
      qaAttempts: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const taskFixture = (status = 'in-progress') => ({
      id: TASK_ID,
      companyId: COMPANY_ID,
      request: 'Reconcile accounts',
      shortcode: TASK_SHORTCODE,
      plannerRoleId: null,
      status,
      materials: [],
      expected: [],
      completed: null,
      failureReason: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    /** A live `agent` `state_change`, in the shape the company stream sends it. */
    const agentStateChangeEvent = (status: string): WireEvent => ({
      type: 'audit',
      event: {
        id: `state-agent-${status}`,
        timestamp: NOW,
        companyId: COMPANY_ID,
        role: 'orchestrator',
        agentId: AGENT_ID,
        assignmentId: null,
        taskId: null,
        eventType: 'state_change',
        payload: { entity: 'agent', newStatus: status },
      },
    });

    beforeEach(() => {
      installFetchMock();
      respondByRoute([
        [AGENT_ROUTE, { body: agentFixture() }],
        [AGENTS_ROUTE, { body: [agentFixture()] }],
        [TASKS_ROUTE, { body: [taskFixture()] }],
        [ASSIGNMENTS_ROUTE, { body: [assignmentFixture()] }],
        [ROLES_ROUTE, { body: [roleFixture()] }],
        [CONVERSATIONS_ROUTE, { body: [] }],
      ]);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    const findStage = () =>
      screen.findByRole('group', { name: t('visualisation.stage.label') });

    it('opens the tray with live data on a select event, and reflects a live patch', async () => {
      const { queryClient } = renderCompanyVisualisation();
      await findStage();

      act(() => {
        emitTcpEvent({
          event: 'select',
          value: { kind: 'agent', id: AGENT_ID },
        });
      });

      await screen.findByRole('complementary', {
        name: t('visualisation.tray.agentHeading', { role: ROLE_NAME }),
      });
      expect(screen.getByText(statusLabel('running'))).toBeInTheDocument();

      act(() => {
        applyEvent(queryClient, agentStateChangeEvent('paused'));
      });

      expect(
        await screen.findByText(statusLabel('paused')),
      ).toBeInTheDocument();
      expect(screen.queryByText(statusLabel('running'))).toBeNull();
    });

    it('shows the tooltip text at the pointer on hover, and hides it on hover null', async () => {
      renderCompanyVisualisation();
      await findStage();

      act(() => {
        emitTcpEvent({
          event: 'hover',
          value: {
            target: { kind: 'role', id: ROLE_ID },
            x: 42,
            y: 99,
          },
        });
      });

      const tooltip = await screen.findByRole('tooltip');
      expect(tooltip).toHaveTextContent(
        t('visualisation.tooltip.role', { role: ROLE_NAME }),
      );
      expect(tooltip.style.left).toBe('42px');
      expect(tooltip.style.top).toBe('99px');

      act(() => {
        emitTcpEvent({ event: 'hover', value: null });
      });

      expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('hides a showing tooltip on Escape, and shows again for a new hover target', async () => {
      renderCompanyVisualisation();
      await findStage();

      act(() => {
        emitTcpEvent({
          event: 'hover',
          value: { target: { kind: 'role', id: ROLE_ID }, x: 1, y: 1 },
        });
      });
      await screen.findByRole('tooltip');

      act(() => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      });
      expect(screen.queryByRole('tooltip')).toBeNull();

      // The pointer moving within the same target must not bring it back.
      act(() => {
        emitTcpEvent({
          event: 'hover',
          value: { target: { kind: 'role', id: ROLE_ID }, x: 2, y: 2 },
        });
      });
      expect(screen.queryByRole('tooltip')).toBeNull();

      // A different target shows again.
      act(() => {
        emitTcpEvent({
          event: 'hover',
          value: { target: { kind: 'task', id: TASK_ID }, x: 3, y: 3 },
        });
      });
      await screen.findByRole('tooltip');
    });

    it("opens the tray for the picker's choice", async () => {
      const user = userEvent.setup();
      renderCompanyVisualisation();
      await findStage();

      await user.click(
        screen.getByRole('button', {
          name: new RegExp(t('visualisation.picker.label')),
        }),
      );
      await user.click(
        screen.getByRole('option', {
          name: t('visualisation.picker.task', { shortcode: TASK_SHORTCODE }),
        }),
      );

      await screen.findByRole('complementary', {
        name: t('visualisation.tray.taskHeading', {
          shortcode: TASK_SHORTCODE,
        }),
      });
    });

    it('emits camera-follow with the selection from the Follow toggle, and follow-stopped un-presses it', async () => {
      const user = userEvent.setup();
      renderCompanyVisualisation();
      await findStage();

      const onCameraFollow = vi.fn();
      onTcpEvent({ event: 'camera-follow', fn: onCameraFollow });

      act(() => {
        emitTcpEvent({
          event: 'select',
          value: { kind: 'role', id: ROLE_ID },
        });
      });
      await screen.findByRole('complementary', {
        name: t('visualisation.tray.roleHeading', { name: ROLE_NAME }),
      });

      const followButton = screen.getByRole('button', {
        name: t('visualisation.tray.follow'),
      });
      await user.click(followButton);

      expect(followButton).toHaveAttribute('aria-pressed', 'true');
      expect(lastValue(onCameraFollow)).toEqual({
        kind: 'role',
        id: ROLE_ID,
      });

      act(() => {
        emitTcpEvent({ event: 'follow-stopped', value: undefined });
      });

      expect(followButton).toHaveAttribute('aria-pressed', 'false');

      offTcpEvent({ event: 'camera-follow', fn: onCameraFollow });
    });

    it('emits camera-pan from a pan button, from arrow keys and WASD on the focused stage, and not with a modifier held', async () => {
      const user = userEvent.setup();
      renderCompanyVisualisation();
      const stage = await findStage();

      const onCameraPan = vi.fn();
      onTcpEvent({ event: 'camera-pan', fn: onCameraPan });

      await user.click(
        screen.getByRole('button', { name: t('visualisation.pan.right') }),
      );
      expect(lastValue(onCameraPan)).toEqual({ dx: PAN_STEP_PX, dy: 0 });

      stage.focus();

      await user.keyboard('{ArrowLeft}');
      expect(lastValue(onCameraPan)).toEqual({ dx: -PAN_STEP_PX, dy: 0 });

      await user.keyboard('w');
      expect(lastValue(onCameraPan)).toEqual({ dx: 0, dy: -PAN_STEP_PX });

      await user.keyboard('s');
      expect(lastValue(onCameraPan)).toEqual({ dx: 0, dy: PAN_STEP_PX });

      await user.keyboard('d');
      expect(lastValue(onCameraPan)).toEqual({ dx: PAN_STEP_PX, dy: 0 });

      const callsBeforeModifier = onCameraPan.mock.calls.length;
      await user.keyboard('{Control>}{ArrowLeft}{/Control}');
      expect(onCameraPan.mock.calls.length).toBe(callsBeforeModifier);

      offTcpEvent({ event: 'camera-pan', fn: onCameraPan });
    });

    describe('double-click full screen', () => {
      let requestFullscreen: Mock<() => Promise<void>>;

      beforeEach(() => {
        requestFullscreen = vi.fn<() => Promise<void>>(() => Promise.resolve());
        Element.prototype.requestFullscreen = requestFullscreen;
      });

      afterEach(() => {
        Reflect.deleteProperty(Element.prototype, 'requestFullscreen');
      });

      it('toggles full screen on a double-click with nothing hovered', async () => {
        const user = userEvent.setup();
        renderCompanyVisualisation();
        const stage = await findStage();

        await user.dblClick(stage);

        expect(requestFullscreen).toHaveBeenCalledTimes(1);
      });

      it('does not toggle full screen on a double-click while a tooltip is showing', async () => {
        const user = userEvent.setup();
        renderCompanyVisualisation();
        const stage = await findStage();

        act(() => {
          emitTcpEvent({
            event: 'hover',
            value: { target: { kind: 'role', id: ROLE_ID }, x: 1, y: 1 },
          });
        });
        await screen.findByRole('tooltip');

        await user.dblClick(stage);

        expect(requestFullscreen).not.toHaveBeenCalled();
      });
    });

    it('closes the tray on Close, and puts focus on the stage', async () => {
      const user = userEvent.setup();
      renderCompanyVisualisation();
      await findStage();

      act(() => {
        emitTcpEvent({
          event: 'select',
          value: { kind: 'role', id: ROLE_ID },
        });
      });
      await screen.findByRole('complementary', {
        name: t('visualisation.tray.roleHeading', { name: ROLE_NAME }),
      });

      await user.click(
        screen.getByRole('button', { name: t('visualisation.tray.close') }),
      );

      expect(screen.queryByRole('complementary')).toBeNull();
      const stage = screen.getByRole('group', {
        name: t('visualisation.stage.label'),
      });
      await waitFor(() => {
        expect(stage).toHaveFocus();
      });
    });

    it('does not move focus when the tray opens', async () => {
      renderCompanyVisualisation();
      await findStage();

      const focusedBefore = document.activeElement;

      act(() => {
        emitTcpEvent({
          event: 'select',
          value: { kind: 'role', id: ROLE_ID },
        });
      });
      await screen.findByRole('complementary', {
        name: t('visualisation.tray.roleHeading', { name: ROLE_NAME }),
      });

      expect(document.activeElement).toBe(focusedBefore);
    });

    describe('accessibility', () => {
      it('has no violations with no tray', async () => {
        const { container } = renderCompanyVisualisation();
        await findStage();

        await expectNoA11yViolations(container);
      });

      it('has no violations with the tray open', async () => {
        const { container } = renderCompanyVisualisation();
        await findStage();

        act(() => {
          emitTcpEvent({
            event: 'select',
            value: { kind: 'role', id: ROLE_ID },
          });
        });
        await screen.findByRole('complementary', {
          name: t('visualisation.tray.roleHeading', { name: ROLE_NAME }),
        });

        await expectNoA11yViolations(container);
      });

      it('has no violations with the tooltip showing', async () => {
        const { container } = renderCompanyVisualisation();
        await findStage();

        act(() => {
          emitTcpEvent({
            event: 'hover',
            value: { target: { kind: 'role', id: ROLE_ID }, x: 1, y: 1 },
          });
        });
        await screen.findByRole('tooltip');

        await expectNoA11yViolations(container);
      });

      it('has no violations with the picker open', async () => {
        const user = userEvent.setup();
        renderCompanyVisualisation();
        await findStage();

        await user.click(
          screen.getByRole('button', {
            name: new RegExp(t('visualisation.picker.label')),
          }),
        );

        // document.body, not container: React Aria's Popover portals the
        // listbox out of the render container, so scanning container would
        // examine a tree with no options in it and pass vacuously.
        await expectNoA11yViolations(document.body);
      });

      it('has no violations with every label on and a doorway tooltip showing', async () => {
        const user = userEvent.setup();
        const { container } = renderCompanyVisualisation();
        await findStage();

        for (const kind of ['agents', 'roles', 'furniture', 'rooms'] as const) {
          await user.click(
            screen.getByRole('checkbox', {
              name: t(`visualisation.labels.${kind}`),
            }),
          );
        }
        act(() => {
          emitTcpEvent({
            event: 'hover',
            value: { target: { kind: 'room', id: 'rec' }, x: 1, y: 1 },
          });
        });
        await screen.findByRole('tooltip');

        await expectNoA11yViolations(container);
      });

      it('shows a pan button tooltip inside the office view, with no violations', async () => {
        const user = userEvent.setup();
        const { container } = renderCompanyVisualisation();
        await findStage();

        await user.tab();
        const tooltip = await screen.findByRole('tooltip');

        // Portalled into the view, not onto the body: in full screen only the
        // full-screen element is drawn, and on the page it stays inside the
        // landmarks the view sits in.
        expect(container).toContainElement(tooltip);
        await expectNoA11yViolations(container);
      });

      it('tabs through the controls in reading order, ending on the stage', async () => {
        const user = userEvent.setup();
        renderCompanyVisualisation();
        const stage = await findStage();

        const expected = [
          screen.getByRole('button', { name: t('visualisation.pan.left') }),
          screen.getByRole('button', { name: t('visualisation.pan.right') }),
          screen.getByRole('button', { name: t('visualisation.pan.up') }),
          screen.getByRole('button', { name: t('visualisation.pan.down') }),
          screen.getByRole('button', { name: t('visualisation.fullscreen') }),
          screen.getByRole('button', {
            name: new RegExp(t('visualisation.picker.label')),
          }),
          ...(['agents', 'roles', 'furniture', 'rooms'] as const).map((kind) =>
            screen.getByRole('checkbox', {
              name: t(`visualisation.labels.${kind}`),
            }),
          ),
          stage,
        ];

        for (const element of expected) {
          await user.tab();
          expect(element).toHaveFocus();
        }
      });
    });
  });
});
