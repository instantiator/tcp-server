import type { LcpTask } from '@lcp/shared';
import { Injectable, Logger } from '@nestjs/common';

/**
 * Dispatches the planner agent for a task once it enters `planning`.
 *
 * A logged no-op in this part (task-orchestration part 3) — `TaskService.start`
 * transitions the task's status and calls this so the wiring point exists;
 * part 7 (`docs/prompts/010.2.7`) replaces the body with the real dispatch.
 */
@Injectable()
export class TaskDispatcher {
  private readonly logger = new Logger(TaskDispatcher.name);

  async dispatchPlanner(task: LcpTask): Promise<void> {
    this.logger.log(
      `dispatchPlanner(${task.id}) — no-op until task-orchestration part 7`,
    );
    await Promise.resolve();
  }
}
