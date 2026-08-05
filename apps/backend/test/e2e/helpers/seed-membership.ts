import { CompanyUser } from '@tcp/shared';
import type { UUID } from 'crypto';
import { Repository } from 'typeorm';

/**
 * Adds a {@link CompanyUser} row so `identifier` can reach `companyId` under
 * membership enforcement (002.05).
 *
 * `POST /api/company` creates this row for its caller automatically; a suite
 * that builds its company straight through the repository has to add it, or
 * every request it makes afterwards is a 403. `'test-user'` is the default
 * `sub` in {@link makeTestJwt}.
 */
export async function seedMembership(
  repo: Repository<CompanyUser>,
  companyId: UUID,
  identifier = 'test-user',
): Promise<CompanyUser> {
  return repo.save(
    repo.create({
      companyId,
      identifier,
      name: identifier,
      memberType: 'creator',
      roles: [],
      knowledgeDomains: [],
    }),
  );
}
