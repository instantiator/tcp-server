import {
  TcpAssignment,
  TcpAssignmentWorkingArtifact,
  TcpTask,
  resolveArtifactKey,
  taskCompletedPrefix,
} from '@tcp/shared';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DbService } from '../db/db.service';
import { StorageService } from '../storage/storage.service';

/**
 * Builds the corrective message returned to the agent on a gate failure.
 */
export function buildGateMessage(problems: string[]): string {
  return [
    'Your submission does not yet meet the assignment’s expected outputs:',
    ...problems.map((p) => `- ${p}`),
    '',
    'Fix each item above, then call complete_assignment again with the corrected `prepared` list. `prepared` holds the artifacts you are handing over — a `{ type: "assignment-working-path", value }` entry per file, and/or a `{ type: "inline-text", value }` entry per text answer.',
  ].join('\n');
}

/**
 * The mechanical gate a submission must pass before it is accepted: does the
 * agent's `prepared` list actually cover what it was asked to produce, and do
 * the files it claims exist?
 *
 * Shape only — judging whether the *content* is right is the QA agent's job, so
 * the gate never blocks a reasonable submission before QA can see it. Both
 * checks return the list of unmet requirements, empty when the submission
 * passes.
 */
@Injectable()
export class OutputGateService {
  constructor(
    @InjectRepository(TcpTask)
    private readonly taskRepo: Repository<TcpTask>,
    private readonly db: DbService,
    private readonly storage: StorageService,
  ) {}

  /**
   * The per-assignment gate:
   *
   * - each expected `assignment-working-path` must appear in `prepared` and its
   *   resolved storage key must exist;
   * - each expected `inline-text` requires a non-empty `inline-text` artifact in
   *   `prepared` (its content is judged by QA, not matched here — the expected
   *   `value` is a description for the agent/QA, not an enforced pattern);
   * - each prepared `assignment-working-path` must exist in storage.
   */
  async checkAssignmentOutputs(
    assignment: TcpAssignment,
    prepared: TcpAssignmentWorkingArtifact[],
  ): Promise<string[]> {
    const company = await this.db.getCompany(assignment.companyId);
    if (!company) {
      // No slug means no key resolution is possible — fail closed.
      return [`Company ${assignment.companyId} not found.`];
    }
    const ctx = {
      companySlug: company.slug,
      task: assignment.taskId ? { id: assignment.taskId } : null,
      assignment: {
        id: assignment.id,
        taskId: assignment.taskId ?? null,
        orderIndex: assignment.orderIndex ?? null,
      },
    };

    const preparedPaths = prepared.filter(
      (p) => p.type === 'assignment-working-path',
    );
    const hasInline = prepared.some(
      (p) => p.type === 'inline-text' && p.value.trim() !== '',
    );

    const problems = this.missingExpectedOutputs(
      assignment.expected,
      preparedPaths,
      hasInline,
    );

    // Every prepared file must exist in storage.
    const keys: string[] = [];
    for (const p of preparedPaths) {
      const key = resolveArtifactKey(p, ctx);
      if (key) keys.push(key);
    }
    if (keys.length > 0) {
      const missing = await this.storage.checkMissingFiles(keys);
      // Map missing keys back to the artifact values for a friendlier message.
      for (const p of preparedPaths) {
        const key = resolveArtifactKey(p, ctx);
        if (key && missing.includes(key)) {
          problems.push(
            `Prepared file '${p.value}' does not exist in storage.`,
          );
        }
      }
    }

    return problems;
  }

  /**
   * The finalise gate: checks the task's `expected` outputs against the files
   * actually in the task `completed/` directory (the finalise agent's working
   * area), rather than against one assignment's working directory.
   */
  async checkTaskExpectations(
    finalise: TcpAssignment,
    prepared: TcpAssignmentWorkingArtifact[],
  ): Promise<string[]> {
    const problems: string[] = [];
    const company = await this.db.getCompany(finalise.companyId);
    if (!company) return [`Company ${finalise.companyId} not found.`];
    const task = await this.taskRepo.findOneBy({ id: finalise.taskId! });
    if (!task) return [`Task ${finalise.taskId} not found.`];

    const present = new Set(
      (
        await this.storage.listFiles(taskCompletedPrefix(company.slug, task.id))
      ).map((f) => f.name),
    );
    const hasInline = prepared.some(
      (p) => p.type === 'inline-text' && p.value.trim() !== '',
    );
    for (const exp of task.expected) {
      if (exp.type === 'task-completed-path' && !present.has(exp.value)) {
        problems.push(
          `Expected deliverable '${exp.value}' is not among the task's completed files (present: ${[...present].join(', ') || 'none'}). Rename or create a file so '${exp.value}' appears in the completed set.`,
        );
      } else if (exp.type === 'inline-text' && !hasInline) {
        problems.push(
          exp.value
            ? `Expected a text answer (${exp.value}): include it as an inline-text artifact in your prepared list.`
            : `Expected a text answer: include it as an inline-text artifact in your prepared list.`,
        );
      }
    }
    return problems;
  }

  /**
   * Expected-output coverage: which of the assignment's stated outputs the
   * prepared list does not account for.
   */
  private missingExpectedOutputs(
    expected: TcpAssignment['expected'],
    preparedPaths: TcpAssignmentWorkingArtifact[],
    hasInline: boolean,
  ): string[] {
    const problems: string[] = [];
    for (const exp of expected) {
      if (exp.type === 'assignment-working-path') {
        if (!preparedPaths.some((p) => p.value === exp.value)) {
          problems.push(
            `Expected file '${exp.value}': create it in your working directory, then include it in your prepared list as { "type": "assignment-working-path", "value": "${exp.value}" }.`,
          );
        }
      } else if (exp.type === 'inline-text' && !hasInline) {
        problems.push(
          exp.value
            ? `Expected a text answer (${exp.value}): include it in your prepared list as { "type": "inline-text", "value": "<your text>" } — a file is not accepted for this output.`
            : `Expected a text answer: include it in your prepared list as { "type": "inline-text", "value": "<your text>" } — a file is not accepted for this output.`,
        );
      }
    }
    return problems;
  }
}
