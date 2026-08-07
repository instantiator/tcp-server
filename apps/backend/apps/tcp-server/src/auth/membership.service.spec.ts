import { CompanyUser } from '@tcp/shared';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { In, Repository } from 'typeorm';
import { MembershipService } from './membership.service';

const makeConfig = (admins: string): ConfigService =>
  ({ get: () => admins }) as unknown as ConfigService;

const makeRepo = (): jest.Mocked<Pick<Repository<CompanyUser>, 'findOne'>> => ({
  findOne: jest.fn().mockResolvedValue(null),
});

const make = (
  admins = '',
): {
  service: MembershipService;
  repo: ReturnType<typeof makeRepo>;
} => {
  const repo = makeRepo();
  return {
    repo,
    service: new MembershipService(
      makeConfig(admins),
      repo as unknown as Repository<CompanyUser>,
    ),
  };
};

describe('MembershipService', () => {
  describe('isMember', () => {
    it('matches on any identifier the caller holds', async () => {
      const { service, repo } = make();
      const companyId = randomUUID();
      repo.findOne.mockResolvedValue({ id: randomUUID() } as CompanyUser);

      await expect(
        service.isMember(['sub-1', 'user@example.com'], companyId),
      ).resolves.toBe(true);
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { companyId, identifier: In(['sub-1', 'user@example.com']) },
        select: { id: true },
      });
    });

    // The ADR-011 data-shape trap: a row created with an email is invisible to
    // a lookup that matches on `sub` alone.
    it('finds a membership keyed by email', async () => {
      const { service, repo } = make();
      repo.findOne.mockResolvedValue({ id: randomUUID() } as CompanyUser);
      await expect(
        service.isMember(['sub-1', 'user@example.com'], randomUUID()),
      ).resolves.toBe(true);
    });

    it('returns false when no row matches', async () => {
      const { service } = make();
      await expect(service.isMember(['sub-1'], randomUUID())).resolves.toBe(
        false,
      );
    });

    // `In([])` matches everything on some drivers; a token carrying neither
    // claim is a member of nothing, and must never reach the query at all.
    it('is a member of nothing, without querying, for an empty identifier list', async () => {
      const { service, repo } = make();
      await expect(service.isMember([], randomUUID())).resolves.toBe(false);
      expect(repo.findOne).not.toHaveBeenCalled();
    });
  });

  describe('isAdmin', () => {
    it('recognises an identifier named in the configured list', () => {
      const { service } = make('root@example.com,ops-machine');
      expect(service.isAdmin(['ops-machine'])).toBe(true);
      expect(service.isAdmin(['someone-else'])).toBe(false);
    });

    it('tolerates whitespace and empty entries', () => {
      const { service } = make(' root@example.com , , ops-machine ');
      expect(service.isAdmin(['root@example.com'])).toBe(true);
      expect(service.isAdmin(['ops-machine'])).toBe(true);
    });

    // Fail closed: a deployment that forgets to configure administrators
    // loses the administrative view rather than granting it to everyone.
    it.each(['', '  ', ',,'])(
      'makes nobody an administrator for %p',
      (admins) => {
        const { service } = make(admins);
        expect(service.isAdmin(['anyone', ''])).toBe(false);
      },
    );

    it('makes nobody an administrator for a caller with no identifiers', () => {
      const { service } = make('root@example.com');
      expect(service.isAdmin([])).toBe(false);
    });
  });
});
