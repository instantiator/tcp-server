import { randomUUID, UUID } from 'crypto';
import { Repository } from 'typeorm';
import { claimStatus } from './claim-status';

interface FakeEntity {
  id: UUID;
  status: string;
  failureReason?: string;
}

describe('claimStatus', () => {
  let queryBuilder: {
    update: jest.Mock;
    set: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    execute: jest.Mock;
  };
  let repo: { createQueryBuilder: jest.Mock; target: unknown };

  beforeEach(() => {
    queryBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    repo = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      target: 'FakeEntity',
    };
  });

  it('sets the new status and returns the affected row count when the claim succeeds', async () => {
    const id = randomUUID();
    const affected = await claimStatus(
      repo as unknown as Repository<FakeEntity>,
      id,
      'in-progress',
      'succeeded',
    );

    expect(affected).toBe(1);
    expect(queryBuilder.set).toHaveBeenCalledWith({ status: 'succeeded' });
    expect(queryBuilder.where).toHaveBeenCalledWith('id = :id', { id });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('status = :from', {
      from: 'in-progress',
    });
  });

  it('merges extra columns into the same update', async () => {
    const id = randomUUID();
    await claimStatus(
      repo as unknown as Repository<FakeEntity>,
      id,
      'in-progress',
      'failed',
      { failureReason: 'boom' },
    );

    expect(queryBuilder.set).toHaveBeenCalledWith({
      status: 'failed',
      failureReason: 'boom',
    });
  });

  it('returns 0 when another writer already moved the row off `from`', async () => {
    queryBuilder.execute.mockResolvedValue({ affected: 0 });

    const affected = await claimStatus(
      repo as unknown as Repository<FakeEntity>,
      randomUUID(),
      'in-progress',
      'succeeded',
    );

    expect(affected).toBe(0);
  });

  it('treats a null `affected` as 0 rows claimed', async () => {
    queryBuilder.execute.mockResolvedValue({ affected: null });

    const affected = await claimStatus(
      repo as unknown as Repository<FakeEntity>,
      randomUUID(),
      'in-progress',
      'succeeded',
    );

    expect(affected).toBe(0);
  });
});
