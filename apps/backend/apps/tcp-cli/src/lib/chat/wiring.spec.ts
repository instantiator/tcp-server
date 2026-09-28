// These specs drive runTuiInteractive against fake ChatSession/Tui stand-ins
// (the same "cast a plain jest.fn()-backed object as the real class" pattern
// session.spec.ts uses for its fakeTui()) — this is the layer where both
// reported bugs actually live: dispatchInitiateTaskKey (tui-keys.ts) already
// stops a second Enter reaching onSubmitInitiateTask, but this handler must
// not rely solely on that caller either (defence in depth — see
// wiring.ts's own initiateTaskSubmitting guard); and onSelectTask must
// survive a malformed (missing `task`) success body without throwing.

import type { TaskChangeSummary, TcpTask } from '@tcp/shared';
import type { AssignmentInfo, InitiateTaskSubmission, Tui } from '../tui/tui';
import type { ChatSession } from './session';
import { runTuiInteractive } from './wiring';

/** Minimal Tui stand-in exposing only what runTuiInteractive calls — the
 * `onX` methods just need to be spies so the registered handler can be
 * pulled back out of `.mock.calls` and invoked directly. */
function fakeTui() {
  return {
    onQuit: jest.fn(),
    onSubmit: jest.fn(),
    onSelectRole: jest.fn(),
    onRefreshRoster: jest.fn(),
    onSelectTask: jest.fn(),
    onOpenInitiateTask: jest.fn(),
    onSubmitInitiateTask: jest.fn(),
    onSelectAssignment: jest.fn(),
    onCancelTask: jest.fn(),
    onStartTask: jest.fn(),
    onCloseTab: jest.fn(),
    stop: jest.fn(),
    switchToPane: jest.fn(),
    addTaskPane: jest.fn(),
    replaceWithTaskPane: jest.fn(),
    hasPane: jest.fn().mockReturnValue(false),
    updateRosterRoles: jest.fn(),
    updateRosterTasks: jest.fn(),
    addInitiateTaskPane: jest.fn(),
  } as unknown as Tui;
}

/** Minimal ChatSession stand-in — every method runTuiInteractive can call,
 * defaulted to a quiet no-op/resolved-empty so tests only need to override
 * what they actually exercise. */
function fakeSession(): ChatSession {
  return {
    hasInFlightTurns: false,
    companyId: 'company-1',
    abortAllTurns: jest.fn(),
    isBusy: jest.fn().mockReturnValue(false),
    runTurn: jest.fn().mockResolvedValue(undefined),
    fetchRoles: jest.fn().mockResolvedValue([]),
    fetchTasks: jest.fn().mockResolvedValue([]),
    fetchTaskDetail: jest.fn(),
    fetchCompanyDefaultPlannerRoleId: jest.fn().mockResolvedValue(undefined),
    createTask: jest.fn(),
    startAssignmentPane: jest.fn(),
    openAssignmentChatPane: jest.fn().mockResolvedValue(undefined),
    cancelTask: jest.fn().mockResolvedValue(undefined),
    startTask: jest.fn().mockResolvedValue(undefined),
    closeTab: jest.fn().mockResolvedValue(undefined),
    cleanup: jest.fn().mockResolvedValue(undefined),
    reportPaneError: jest.fn(),
    watchTaskEvents: jest.fn(),
  } as unknown as ChatSession;
}

const submission: InitiateTaskSubmission = {
  companyId: 'company-1',
  request: 'Write a report',
  plannerRoleId: 'role-1',
  expected: [],
  startImmediately: false,
};

/** Flushes the microtask queue so a `.then`/`.catch` chained inside
 * runTuiInteractive's handlers has run. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Pulls the handler passed to a jest.fn()-backed `tui.onX(...)` registration
 * call back out, explicitly typed — `jest.Mock.calls` is `any[][]`, so
 * indexing into it directly trips `no-unsafe-member-access`; casting the
 * whole array to `[Handler][]` up front keeps every access after that typed.
 */
function registeredHandler<Handler>(onX: unknown): Handler {
  const calls = (onX as jest.Mock).mock.calls as [Handler][];
  return calls[0][0];
}

describe('runTuiInteractive', () => {
  /** Runs the interactive loop, returning both fakes and a `quit()` helper
   * that resolves it cleanly (idle path) so the test can await completion
   * without leaving a dangling promise. */
  function start(session: ChatSession, tui: Tui) {
    const done = runTuiInteractive(session, tui);
    const quit = async () => {
      registeredHandler<() => void>(tui.onQuit)();
      await done;
    };
    return quit;
  }

  describe('onSubmitInitiateTask', () => {
    it('ignores a second submission on the same pane while the first is still in flight', async () => {
      const tui = fakeTui();
      const session = fakeSession();
      // Never resolves within this test — stands in for the real request
      // still being in flight when the second Enter would otherwise arrive.
      (session.createTask as jest.Mock).mockReturnValue(new Promise(() => {}));
      const quit = start(session, tui);

      const onSubmitInitiateTask = registeredHandler<
        (paneId: string, submission: InitiateTaskSubmission) => void
      >(tui.onSubmitInitiateTask);

      onSubmitInitiateTask('__initiate_task__', submission);
      onSubmitInitiateTask('__initiate_task__', submission);
      onSubmitInitiateTask('__initiate_task__', submission);

      expect(session.createTask).toHaveBeenCalledTimes(1);

      await quit();
    });

    it('creates the task, hands off to the task pane, and starts watching it on success', async () => {
      const tui = fakeTui();
      const session = fakeSession();
      const task = {
        id: 'task-1',
        shortcode: '000',
        request: 'Write a report',
        status: 'ready',
      } as unknown as TcpTask;
      const assignments: AssignmentInfo[] = [];
      (session.createTask as jest.Mock).mockResolvedValue({
        task,
        assignments,
      });
      const quit = start(session, tui);

      const onSubmitInitiateTask = registeredHandler<
        (paneId: string, submission: InitiateTaskSubmission) => void
      >(tui.onSubmitInitiateTask);
      onSubmitInitiateTask('__initiate_task__', submission);
      await flush();

      expect(tui.replaceWithTaskPane).toHaveBeenCalledWith(
        '__initiate_task__',
        {
          id: 'task-1',
          label: 'Task: 000',
          prompt: 'Write a report',
          status: 'ready',
          assignments: [],
        },
      );
      expect(session.watchTaskEvents).toHaveBeenCalledWith('task-1');

      await quit();
    });

    it('reports the error and allows a retry after createTask rejects', async () => {
      const tui = fakeTui();
      const session = fakeSession();
      (session.createTask as jest.Mock)
        .mockRejectedValueOnce(new Error('boom'))
        .mockReturnValueOnce(new Promise(() => {}));
      const quit = start(session, tui);

      const onSubmitInitiateTask = registeredHandler<
        (paneId: string, submission: InitiateTaskSubmission) => void
      >(tui.onSubmitInitiateTask);
      onSubmitInitiateTask('__initiate_task__', submission);
      await flush();

      expect(session.reportPaneError).toHaveBeenCalledWith(
        '__initiate_task__',
        expect.any(Error),
      );

      // The guard cleared on failure, so a fresh attempt reaches createTask
      // again rather than being silently swallowed forever.
      onSubmitInitiateTask('__initiate_task__', submission);
      expect(session.createTask).toHaveBeenCalledTimes(2);

      await quit();
    });
  });

  describe('onSelectTask', () => {
    const taskSummary: TaskChangeSummary = {
      id: 'task-1' as TaskChangeSummary['id'],
      status: 'ready',
      request: 'Write a report',
      shortcode: '000',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      completedSteps: 0,
      totalSteps: 0,
    };

    it('opens the task panel when fetchTaskDetail resolves with a real task', async () => {
      const tui = fakeTui();
      const session = fakeSession();
      const task = {
        id: 'task-1',
        shortcode: '000',
        request: 'Write a report',
        status: 'ready',
      } as unknown as TcpTask;
      (session.fetchTaskDetail as jest.Mock).mockResolvedValue({
        task,
        assignments: [],
      });
      const quit = start(session, tui);

      const onSelectTask = registeredHandler<(task: TaskChangeSummary) => void>(
        tui.onSelectTask,
      );
      onSelectTask(taskSummary);
      await flush();

      expect(tui.addTaskPane).toHaveBeenCalledWith({
        id: 'task-1',
        label: 'Task: 000',
        prompt: 'Write a report',
        status: 'ready',
        assignments: [],
      });
      expect(tui.switchToPane).toHaveBeenCalledWith('task-1');
      expect(session.watchTaskEvents).toHaveBeenCalledWith('task-1');
      expect(session.reportPaneError).not.toHaveBeenCalled();

      await quit();
    });
  });
});
