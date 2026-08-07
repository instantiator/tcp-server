import {
  assignmentWorkingPrefix,
  isStorageReadOnly,
  TcpAssignment,
  TcpAssignmentMode,
  orphanWorkingPrefix,
  resolveArtifactKey,
  taskCompletedPrefix,
} from '@tcp/shared';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DbService } from '../db/db.service';

/** A single material resolved to a concrete storage key (or literal inline text). */
export interface ResolvedMaterial {
  /** Stable name the model addresses the material by (`inline-N` for inline text). */
  name: string;
  /** Full storage key, or `null` for an inline-text material. */
  key: string | null;
  /** Literal content, present only for inline-text materials. */
  inlineText?: string;
}

/**
 * The storage scope for an agent, resolved server-side from its assignment —
 * backs the assignment-scoped storage tools in tcp-mcp-storage (part 6). For a
 * qa-mode caller the scope is the *target* assignment's (read-only).
 */
export interface StorageScope {
  mode: TcpAssignmentMode;
  /** True for qa-mode callers — the working tools may only read. */
  readOnly: boolean;
  /** Object-key prefix (ending in `/`) of the scoped working directory. */
  workingPrefix: string;
  /** The scoped assignment's materials, resolved to concrete keys/inline text. */
  materials: ResolvedMaterial[];
}

/**
 * Decides which slice of object storage an agent's scoped tools may see: the
 * working directory it reads and writes, and its materials resolved to concrete
 * keys. This is the server-side half of the storage permission model — the
 * agent never names a raw key, so anything outside the scope is unreachable.
 */
@Injectable()
export class StorageScopeService {
  constructor(
    @InjectRepository(TcpAssignment)
    private readonly assignmentRepo: Repository<TcpAssignment>,
    private readonly db: DbService,
  ) {}

  /**
   * Resolves the {@link StorageScope} for the agent working `caller`.
   *
   * The read/write vs read-only distinction comes from {@link MODE_TOOLS} (via
   * {@link isStorageReadOnly}), the single source of truth shared with the
   * client-side tool filter. The working area depends on the mode:
   * `implement`/`consultee` get their own assignment's working directory; a `qa`
   * caller gets the *target* assignment's working directory (read-only); a
   * `finalise` caller gets the *task* `completed/` directory (read-write, to
   * bring the deliverables up to the task's expected outputs); `plan` gets its
   * own (read-only). Materials are the scoped assignment's `materials`, resolved
   * to concrete storage keys ({@link resolveArtifactKey}), with inline-text
   * materials keyed by a stable `inline-N` synthetic name.
   */
  async resolve(caller: TcpAssignment): Promise<StorageScope> {
    const readOnly = isStorageReadOnly(caller.mode);
    // Only qa works against another assignment's output; every other mode works
    // in its own area.
    const target =
      caller.mode === 'qa' ? await this.loadTargetAssignment(caller) : caller;

    const company = await this.db.getCompany(caller.companyId);
    if (!company) {
      throw new NotFoundException(`Company ${caller.companyId} not found`);
    }
    const slug = company.slug;

    const workingPrefix =
      caller.mode === 'finalise' && caller.taskId != null
        ? taskCompletedPrefix(slug, caller.taskId)
        : target.taskId != null && target.orderIndex != null
          ? assignmentWorkingPrefix(slug, target.taskId, target.orderIndex)
          : orphanWorkingPrefix(slug, target.id);

    const materials = await this.resolveMaterials(slug, target);
    return { mode: caller.mode, readOnly, workingPrefix, materials };
  }

  /** Loads the assignment a qa-mode caller is reviewing. */
  private async loadTargetAssignment(
    caller: TcpAssignment,
  ): Promise<TcpAssignment> {
    if (!caller.targetAssignmentId) {
      throw new BadRequestException(
        `Your qa assignment has no target assignment to review.`,
      );
    }
    const target = await this.assignmentRepo.findOneBy({
      id: caller.targetAssignmentId,
    });
    if (!target) {
      throw new NotFoundException(
        `Assignment ${caller.targetAssignmentId} not found`,
      );
    }
    return target;
  }

  /**
   * Resolves an assignment's `materials` list to {@link ResolvedMaterial}s.
   * A material that cannot be resolved (e.g. an `assignment-completed-path`
   * no prior assignment has approved) fails the whole scope lookup — a
   * silently incomplete materials list would leave the agent working from
   * missing input with no indication why; `planTask`'s cross-reference check
   * should keep this unreachable for a plan created normally, so this is a
   * backstop, not the expected path.
   */
  private async resolveMaterials(
    slug: string,
    target: TcpAssignment,
  ): Promise<ResolvedMaterial[]> {
    const planAssignments = target.taskId
      ? (
          await this.assignmentRepo.find({
            where: { taskId: target.taskId, mode: 'implement' },
          })
        ).map((a) => ({ orderIndex: a.orderIndex, approved: a.approved }))
      : undefined;
    const ctx = {
      companySlug: slug,
      task: target.taskId ? { id: target.taskId } : null,
      planAssignments,
      assignment: {
        id: target.id,
        taskId: target.taskId ?? null,
        orderIndex: target.orderIndex ?? null,
      },
    };

    const materials: ResolvedMaterial[] = [];
    let inlineCount = 0;
    for (const m of target.materials) {
      if (m.type === 'inline-text') {
        inlineCount += 1;
        materials.push({
          name: `inline-${inlineCount}`,
          key: null,
          inlineText: m.value,
        });
        continue;
      }
      let key: string | null;
      try {
        key = resolveArtifactKey(m, ctx);
      } catch (e) {
        throw new UnprocessableEntityException(
          `Cannot resolve material '${m.value}' (${m.type}): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      // ponytail: name = the artifact's filename; two path materials with
      // the same basename would collide — acceptable until it bites.
      if (key) materials.push({ name: m.value, key });
    }
    return materials;
  }
}
