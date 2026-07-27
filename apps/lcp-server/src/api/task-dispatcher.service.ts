import type { TcpAssignment, TcpTask } from '@lcp/shared';

/**
 * Orchestration reaction hooks for the task lifecycle, invoked by
 * {@link TaskService} and {@link AssignmentService} after each validated state
 * transition. This abstract class is the DI token and contract; the real
 * implementation is {@link TaskOrchestrationService}, bound to this token in
 * {@link ApiModule}. Keeping the hooks behind a token means the transition
 * callers never depend on the (heavier) orchestration service directly.
 */
export abstract class TaskDispatcher {
  /** Called after a task enters `planning` — dispatches the planner agent. */
  abstract dispatchPlanner(task: TcpTask): Promise<void>;

  /** Called after a planner submits a plan — dispatches the first ready assignment. */
  abstract taskPlanned(task: TcpTask): Promise<void>;

  /** Called after an implement agent completes — dispatches a QA agent. */
  abstract assignmentReadyForQa(assignment: TcpAssignment): Promise<void>;

  /** Called after a QA verdict — promotes approved files, or resumes on reject. */
  abstract assignmentAssured(assignment: TcpAssignment): Promise<void>;

  /**
   * Called after a finalise agent completes — records the task's final
   * `completed` set from the completed/ directory and marks the task
   * `succeeded`.
   */
  abstract assignmentFinalised(assignment: TcpAssignment): Promise<void>;

  /**
   * Called after a task is atomically moved to `cancelled` — cascades the
   * cancellation to the task's still-non-terminal assignments and their
   * working agents.
   */
  abstract cancelTask(task: TcpTask): Promise<void>;
}
