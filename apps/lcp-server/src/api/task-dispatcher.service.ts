import type { LcpAssignment, LcpTask } from '@lcp/shared';
import { Injectable, Logger } from '@nestjs/common';

/**
 * Orchestration reaction hooks for the task lifecycle. Every method is a
 * logged no-op today — the state transitions that call them (in `TaskService`
 * and `AssignmentService`) are complete, but the *reactions* (dispatching the
 * planner/first assignment/QA agent, resuming after a QA verdict) are
 * task-orchestration part 7 (`docs/prompts/010.2.7`), which replaces these
 * bodies with the real dispatch. Keeping the hooks here fixes the wiring points
 * so part 7 needs no changes to its callers.
 */
@Injectable()
export class TaskDispatcher {
  private readonly logger = new Logger(TaskDispatcher.name);

  /** Called after a task enters `planning` — part 7 dispatches the planner. */
  async dispatchPlanner(task: LcpTask): Promise<void> {
    this.logger.log(
      `dispatchPlanner(${task.id}) — no-op until task-orchestration part 7`,
    );
    await Promise.resolve();
  }

  /** Called after a planner submits a plan — part 7 dispatches the first assignment. */
  async taskPlanned(task: LcpTask): Promise<void> {
    this.logger.log(
      `taskPlanned(${task.id}) — no-op until task-orchestration part 7`,
    );
    await Promise.resolve();
  }

  /** Called after an implement agent completes — part 7 dispatches a QA agent. */
  async assignmentReadyForQa(assignment: LcpAssignment): Promise<void> {
    this.logger.log(
      `assignmentReadyForQa(${assignment.id}) — no-op until task-orchestration part 7`,
    );
    await Promise.resolve();
  }

  /** Called after a QA verdict — part 7 copies approved files / resumes on reject. */
  async assignmentAssured(assignment: LcpAssignment): Promise<void> {
    this.logger.log(
      `assignmentAssured(${assignment.id}) — no-op until task-orchestration part 7`,
    );
    await Promise.resolve();
  }
}
