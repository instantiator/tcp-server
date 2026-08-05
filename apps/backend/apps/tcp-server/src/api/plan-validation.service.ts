import {
  buildEnumValidationError,
  canonicaliseArtifacts,
  InvalidEnumValue,
  TcpAssignmentWorkingArtifact,
  TcpMaterialArtifact,
} from '@tcp/shared';
import { BadRequestException, Injectable } from '@nestjs/common';
import type { UUID } from 'crypto';
import { DbService } from '../db/db.service';
import {
  invalidArtifactTypeErrors,
  MATERIAL_ARTIFACT_TYPES,
  WORKING_ARTIFACT_TYPES,
} from './artifact-types';
import type { PlanAssignmentInput } from './dto/internal-task.dto';

/**
 * A plan that has passed validation, with everything the create step needs
 * already resolved. Every array is aligned by assignment index.
 */
export interface ValidatedPlan {
  /** The role each assignment is assigned to, resolved from its id or slug. */
  roleIds: UUID[];
  /** Alias-normalised expected artifacts (e.g. `text` → `inline-text`). */
  expectedByIndex: TcpAssignmentWorkingArtifact[][];
  /** Alias-normalised material artifacts. */
  materialsByIndex: TcpMaterialArtifact[][];
}

/**
 * Checks a planner's proposed plan before any of it is created.
 *
 * Every enumerable mistake in the whole plan is collected before throwing, so
 * the planner can correct all of them in a single retry, and each error names
 * the valid options it must choose from.
 */
@Injectable()
export class PlanValidationService {
  constructor(private readonly db: DbService) {}

  /**
   * Validates the proposed assignments and returns their resolved roles and
   * canonicalised artifact lists.
   *
   * @throws {@link BadRequestException} when the plan is structurally malformed,
   *   or when any role, artifact type, or prior-output reference is invalid.
   */
  async validate(
    companyId: UUID,
    assignments: PlanAssignmentInput[],
  ): Promise<ValidatedPlan> {
    this.assertStructurallyValid(assignments);

    const validRoleSlugs = (await this.db.listRoles(companyId)).map(
      (r) => r.slug,
    );
    const invalid: InvalidEnumValue[] = [];
    const plan: ValidatedPlan = {
      roleIds: [],
      expectedByIndex: [],
      materialsByIndex: [],
    };

    for (const [i, a] of assignments.entries()) {
      const role = a.role?.trim()
        ? await this.db.findRoleByIdOrSlug(companyId, a.role)
        : null;
      if (!role) {
        invalid.push({
          property: `assignment ${i} role`,
          value: a.role ?? '',
          validValues: validRoleSlugs,
        });
      }
      // Placeholder keeps roleIds aligned with assignments; only read after the
      // invalid check below passes (so an unresolved role is never used).
      plan.roleIds.push(role?.id ?? ('' as UUID));

      const expected = canonicaliseArtifacts(a.expected ?? []);
      const materials = canonicaliseArtifacts(a.materials ?? []);
      plan.expectedByIndex.push(expected);
      plan.materialsByIndex.push(materials);
      invalid.push(
        ...invalidArtifactTypeErrors(
          expected,
          WORKING_ARTIFACT_TYPES,
          `assignment ${i} expected type`,
        ),
        ...invalidArtifactTypeErrors(
          materials,
          MATERIAL_ARTIFACT_TYPES,
          `assignment ${i} materials type`,
        ),
      );
    }

    invalid.push(...this.danglingPriorOutputs(plan));

    if (invalid.length > 0) {
      throw new BadRequestException(
        buildEnumValidationError('create the plan', invalid),
      );
    }
    return plan;
  }

  /**
   * Structural (non-enumerable) checks fail fast — there is no set of "valid
   * values" to offer for a missing prompt.
   */
  private assertStructurallyValid(assignments: PlanAssignmentInput[]): void {
    if (!Array.isArray(assignments) || assignments.length === 0) {
      throw new BadRequestException(
        'A plan must contain at least one assignment.',
      );
    }
    for (const [i, a] of assignments.entries()) {
      if (!a.prompt || !a.prompt.trim()) {
        throw new BadRequestException(`Assignment ${i}: prompt is required.`);
      }
    }
  }

  /**
   * Cross-reference check: an `assignment-completed-path` material names a
   * prior step's approved output — which only ever exists if an EARLIER
   * assignment in this same plan commits to producing that exact filename
   * (its `expected` list, type `assignment-working-path`; `checkOutputGate`
   * then mechanically enforces the implementer actually produces it). This
   * is purely structural — no execution has to happen to check it — so a
   * typo or a reference to a step that never promises that file is caught
   * here, before anything is created, rather than crashing prompt assembly
   * partway through the plan's execution (see `resolveArtifactKey`).
   */
  private danglingPriorOutputs(plan: ValidatedPlan): InvalidEnumValue[] {
    const invalid: InvalidEnumValue[] = [];
    for (const [i, materials] of plan.materialsByIndex.entries()) {
      const producedByEarlier = plan.expectedByIndex
        .slice(0, i)
        .flatMap((expected) =>
          expected
            .filter((e) => e.type === 'assignment-working-path')
            .map((e) => e.value),
        );
      materials.forEach((m, mi) => {
        if (m.type !== 'assignment-completed-path') return;
        if (!producedByEarlier.includes(m.value)) {
          invalid.push({
            property: `assignment ${i} materials[${mi}] value`,
            value: m.value,
            validValues: producedByEarlier,
          });
        }
      });
    }
    return invalid;
  }
}
