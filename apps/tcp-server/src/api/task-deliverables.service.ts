import {
  assignmentCompletedKey,
  assignmentCompletedPrefix,
  assignmentWorkingKey,
  TcpAssignment,
  TcpCompany,
  TcpMaterialArtifact,
  TcpTask,
  TcpTaskCompletedArtifact,
  taskCompletedKey,
  taskCompletedPrefix,
} from '@tcp/shared';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { TaskStateService } from './task-state.service';

/**
 * Moves a task's artifacts between the storage tiers the lifecycle defines —
 * assignment working → assignment completed → task completed — and derives the
 * artifact lists that get recorded on the rows.
 *
 * Every operation here is idempotent: a re-copy writes the same bytes, so the
 * orchestrator may safely run these before the atomic claim that decides
 * whether its transition actually happened.
 */
@Injectable()
export class TaskDeliverablesService {
  constructor(
    @InjectRepository(TcpTask)
    private readonly taskRepo: Repository<TcpTask>,
    @InjectRepository(TcpCompany)
    private readonly companyRepo: Repository<TcpCompany>,
    private readonly storage: StorageService,
    private readonly state: TaskStateService,
  ) {}

  /** The company's storage slug — the root segment of every artifact key. */
  async companySlug(companyId: UUID): Promise<string> {
    const company = await this.companyRepo.findOneByOrFail({ id: companyId });
    return company.slug;
  }

  /**
   * Copies a QA-accepted assignment's prepared working files into its completed
   * directory, and returns the `approved` artifact list to record on the row.
   * Inline text needs no copy — it is carried across as-is.
   */
  async promoteApproved(
    target: TcpAssignment,
  ): Promise<TcpAssignment['approved']> {
    const slug = await this.companySlug(target.companyId);
    const approved: TcpAssignment['approved'] = [];
    for (const item of target.prepared) {
      if (item.type === 'inline-text') {
        approved.push({ type: 'inline-text', value: item.value });
        continue;
      }
      const source = assignmentWorkingKey(
        slug,
        target.taskId!,
        target.orderIndex!,
        item.value,
      );
      const destination = assignmentCompletedKey(
        slug,
        target.taskId!,
        target.orderIndex!,
        item.value,
      );
      await this.storage.copyFile(source, destination);
      approved.push({ type: 'assignment-completed-path', value: item.value });
    }
    return approved;
  }

  /**
   * Copies every assignment's completed files into the task's completed
   * directory (highest `orderIndex` wins on a filename collision).
   */
  async promoteToTaskCompleted(task: TcpTask): Promise<void> {
    const slug = await this.companySlug(task.companyId);
    const plan = await this.state.planAssignments(task.id);
    // Ascending order so a later assignment's file overwrites an earlier one —
    // the "highest orderIndex wins" collision rule.
    const ordered = [...plan].sort(
      (a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0),
    );
    for (const assignment of ordered) {
      if (assignment.orderIndex == null) continue;
      const files = await this.storage.listFiles(
        assignmentCompletedPrefix(slug, task.id, assignment.orderIndex),
      );
      for (const file of files) {
        await this.storage.copyFile(
          file.key,
          taskCompletedKey(slug, task.id, file.name),
        );
      }
    }
  }

  /**
   * Builds the task's `completed` artifact list from the files currently in its
   * completed/ directory (so a finalise agent's renames/edits are reflected)
   * plus any approved `inline-text` from the plan assignments.
   */
  async buildTaskCompleted(task: TcpTask): Promise<TcpTaskCompletedArtifact[]> {
    const slug = await this.companySlug(task.companyId);
    const files = await this.storage.listFiles(
      taskCompletedPrefix(slug, task.id),
    );
    const plan = await this.state.planAssignments(task.id);
    return [
      ...files.map((f): TcpTaskCompletedArtifact => ({
        type: 'task-completed-path',
        value: f.name,
      })),
      ...plan.flatMap((a) =>
        a.approved
          .filter((art) => art.type === 'inline-text')
          .map((art): TcpTaskCompletedArtifact => ({
            type: 'inline-text',
            value: art.value,
          })),
      ),
    ];
  }

  /**
   * Builds an implement assignment's materials: the task's own materials, plus
   * the `assignment-completed-path` outputs of every prior succeeded implement
   * assignment, plus the planner's per-assignment hints already stored on it.
   * Deduplicated by `(type, value)`; the most-recent version of a duplicated
   * completed-path filename is resolved later by {@link resolveArtifactKey}, so
   * one entry per filename is enough here.
   */
  async mergeMaterials(
    assignment: TcpAssignment,
  ): Promise<TcpMaterialArtifact[]> {
    if (!assignment.taskId) return assignment.materials;
    const task = await this.taskRepo.findOneBy({ id: assignment.taskId });
    const priors = (await this.state.planAssignments(assignment.taskId)).filter(
      (a) =>
        a.status === 'succeeded' &&
        a.orderIndex != null &&
        assignment.orderIndex != null &&
        a.orderIndex < assignment.orderIndex,
    );

    const merged: TcpMaterialArtifact[] = [
      ...(task?.materials ?? []),
      ...priors.flatMap((a) =>
        a.approved
          .filter((art) => art.type === 'assignment-completed-path')
          .map((art): TcpMaterialArtifact => ({
            type: 'assignment-completed-path',
            value: art.value,
          })),
      ),
      ...assignment.materials,
    ];

    const seen = new Set<string>();
    return merged.filter((m) => {
      const key = `${m.type}::${m.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}
