import { ConflictException, ForbiddenException } from '@nestjs/common';
import { MembershipService } from '../auth/membership.service';
import { DbService } from '../db/db.service';

/**
 * Checks that the caller may create a company at `slug`. A taken slug is a
 * 409 unless `replace` is set. Replacing deletes the old company and
 * everything it owns, so it needs the same reach as deleting it: membership
 * of that company, or administrator access. Shared by create and import, so
 * neither can replace a company the other would refuse to.
 */
export async function assertSlugClaimable(
  db: DbService,
  membership: MembershipService,
  slug: string,
  replace: boolean,
  identifiers: string[],
): Promise<void> {
  const existing = await db.getCompany(slug);
  if (!existing) return;
  if (!replace) {
    throw new ConflictException(
      `A company with slug '${slug}' already exists.`,
    );
  }
  if (
    !membership.isAdmin(identifiers) &&
    !(await membership.isMember(identifiers, existing.id))
  ) {
    throw new ForbiddenException(
      'Replacing a company requires membership of it',
    );
  }
}
