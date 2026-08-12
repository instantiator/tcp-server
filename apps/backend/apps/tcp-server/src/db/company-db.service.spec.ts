import { CompanyUser, TcpCompany, TcpRole } from '@tcp/shared';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import { Repository } from 'typeorm';
import { CompanyDbService } from './company-db.service';

const ENTITIES = [TcpCompany, TcpRole, CompanyUser];

describe('CompanyDbService.list', () => {
  let service: CompanyDbService;
  let companyRepo: Repository<TcpCompany>;
  let companyUserRepo: Repository<CompanyUser>;

  /** Ids of the three fixture companies, in creation order. */
  let acme: UUID;
  let beta: UUID;
  let gamma: UUID;

  let testingModule: TestingModule;

  beforeAll(async () => {
    testingModule = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: ENTITIES,
          synchronize: true,
        }),
        TypeOrmModule.forFeature(ENTITIES),
      ],
      providers: [CompanyDbService],
    }).compile();

    service = testingModule.get(CompanyDbService);
    companyRepo = testingModule.get(getRepositoryToken(TcpCompany));
    companyUserRepo = testingModule.get(getRepositoryToken(CompanyUser));

    const make = async (slug: string): Promise<UUID> =>
      (
        await companyRepo.save({
          slug,
          name: slug,
          description: slug,
          mcpServerList: [],
        })
      ).id;

    acme = await make('acme');
    beta = await make('beta');
    gamma = await make('gamma');

    const member = (companyId: UUID, identifier: string) =>
      companyUserRepo.save(
        companyUserRepo.create({
          companyId,
          identifier,
          name: null,
          memberType: 'member',
          roles: [],
          knowledgeDomains: [],
        }),
      );

    await member(acme, 'sub-1');
    await member(beta, 'sub-1');
    // Gamma's only membership row is keyed by an email address, not a `sub`.
    await member(gamma, 'user@example.com');
  });

  // Closes the better-sqlite3 DataSource this module opened. Without it the
  // connection outlives the suite, and `@nestjs/typeorm`'s connection retry —
  // an rxjs timer — can fire after Jest has torn the environment down, at
  // which point re-loading the driver throws "require after teardown".
  afterAll(async () => {
    await testingModule.close();
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns every company when no identifiers are given', async () => {
    const companies = await service.list();
    expect(companies.map((c) => c.id).sort()).toEqual(
      [acme, beta, gamma].sort(),
    );
  });

  it('returns only the companies an identifier is a member of', async () => {
    const companies = await service.list(['sub-1']);
    expect(companies.map((c) => c.id).sort()).toEqual([acme, beta].sort());
  });

  it('finds a company whose only membership row is keyed by email', async () => {
    // The silent failure this scoping exists to avoid: matching on `sub`
    // alone returns an empty list that looks exactly like "not a member".
    const companies = await service.list(['sub-2', 'user@example.com']);
    expect(companies.map((c) => c.id)).toEqual([gamma]);
  });

  it('returns nothing for an identifier that matches no membership', async () => {
    await expect(service.list(['nobody'])).resolves.toEqual([]);
  });

  it('returns [] for an empty identifier list without querying', async () => {
    // An authenticated caller with neither claim is a member of nothing —
    // never a caller who sees everything.
    const companyFind = jest.spyOn(companyRepo, 'find');
    const userFind = jest.spyOn(companyUserRepo, 'find');

    await expect(service.list([])).resolves.toEqual([]);

    expect(companyFind).not.toHaveBeenCalled();
    expect(userFind).not.toHaveBeenCalled();
  });
});
