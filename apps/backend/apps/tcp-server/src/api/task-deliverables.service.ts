import {
  assignmentCompletedKey,
  assignmentCompletedPrefix,
  assignmentWorkingKey,
  assignmentWorkingPrefix,
  RESOURCES_DIR,
  resourcesPrefix,
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
 * Applying a task's resource changes stopped part-way: `applied` lists the
 * resources already changed, so the failure reason can say what landed.
 */
export class ResourceApplyError extends Error {
  constructor(
    readonly path: string,
    readonly applied: string[],
    cause: unknown,
  ) {
    super(
      `Applying company resource changes stopped at '${path}'` +
        ` (already applied: ${applied.join(', ') || 'none'}): ` +
        (cause instanceof Error ? cause.message : String(cause)),
    );
  }
}

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
   * Inline text needs no copy — it is carried across as-is. Every resource
   * draft is promoted too, whether or not the agent listed it in `prepared`:
   * QA has seen them all, and a small model often forgets to list one.
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
      if (item.type === 'resource') continue; // promoted from the listing below
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
    for (const path of await this.resourceDrafts(target)) {
      await this.storage.copyFile(
        assignmentWorkingKey(
          slug,
          target.taskId!,
          target.orderIndex!,
          `${RESOURCES_DIR}${path}`,
        ),
        assignmentCompletedKey(
          slug,
          target.taskId!,
          target.orderIndex!,
          `${RESOURCES_DIR}${path}`,
        ),
      );
      approved.push({ type: 'resource', value: path });
    }
    return approved;
  }

  /** The resource drafts in a task step's working folder, as paths under `resources/`. */
  async resourceDrafts(assignment: TcpAssignment): Promise<string[]> {
    if (assignment.taskId == null || assignment.orderIndex == null) return [];
    const slug = await this.companySlug(assignment.companyId);
    return this.pathsUnder(
      `${assignmentWorkingPrefix(slug, assignment.taskId, assignment.orderIndex)}${RESOURCES_DIR}`,
    );
  }

  /** The resource changes waiting in a task's completed folder, applied when it succeeds. */
  async pendingResourceChanges(task: TcpTask): Promise<string[]> {
    const slug = await this.companySlug(task.companyId);
    return this.pathsUnder(
      `${taskCompletedPrefix(slug, task.id)}${RESOURCES_DIR}`,
    );
  }

  /**
   * Applies a task's resource changes: copies each pending change over the
   * live company resource. Running it again just writes the same content as
   * a new version, so a restart can safely repeat it. The task's own copy
   * stays, as the record of what it changed.
   *
   * ponytail: last write wins if two tasks change one resource; versioning
   * keeps the other. Compare a base version first if lost updates show up.
   *
   * @throws {@link ResourceApplyError} naming what was applied before the failure.
   */
  async applyResourceChanges(task: TcpTask): Promise<string[]> {
    const slug = await this.companySlug(task.companyId);
    const pending = `${taskCompletedPrefix(slug, task.id)}${RESOURCES_DIR}`;
    const applied: string[] = [];
    for (const path of await this.pathsUnder(pending)) {
      try {
        await this.storage.copyFile(
          `${pending}${path}`,
          `${resourcesPrefix(slug)}${path}`,
          { user: null, agent: null, task: task.id },
        );
      } catch (e) {
        throw new ResourceApplyError(path, applied, e);
      }
      applied.push(path);
    }
    return applied;
  }

  /** Every file under `prefix` (all pages), as paths relative to it. */
  private async pathsUnder(prefix: string): Promise<string[]> {
    const files = await this.storage.listFiles(prefix, { all: true });
    return files
      .filter((f) => f.key.startsWith(prefix))
      .map((f) => f.key.slice(prefix.length));
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
      const prefix = assignmentCompletedPrefix(
        slug,
        task.id,
        assignment.orderIndex,
      );
      for (const file of await this.storage.listFiles(prefix, { all: true })) {
        // Resource drafts keep their folders; other files are flattened to
        // their name, as before.
        const rel = file.key.slice(prefix.length);
        await this.storage.copyFile(
          file.key,
          taskCompletedKey(
            slug,
            task.id,
            rel.startsWith(RESOURCES_DIR) ? rel : file.name,
          ),
        );
      }
    }
  }

  /**
   * Builds the task's `completed` artifact list from the files currently in its
   * completed/ directory (so a finalise agent's renames/edits are reflected) —
   * resource changes as `resource` entries — plus any approved `inline-text`
   * from the plan assignments.
   */
  async buildTaskCompleted(task: TcpTask): Promise<TcpTaskCompletedArtifact[]> {
    const slug = await this.companySlug(task.companyId);
    const prefix = taskCompletedPrefix(slug, task.id);
    const files = await this.storage.listFiles(prefix, { all: true });
    const plan = await this.state.planAssignments(task.id);
    return [
      ...files.map((f): TcpTaskCompletedArtifact => {
        const rel = f.key.slice(prefix.length);
        return rel.startsWith(RESOURCES_DIR)
          ? { type: 'resource', value: rel.slice(RESOURCES_DIR.length) }
          : { type: 'task-completed-path', value: f.name };
      }),
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
