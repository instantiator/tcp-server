import type { RecordsService } from '@tcp/shared';
import { randomUUID } from 'crypto';
import type { AuditService } from '../audit/audit.service';
import { RecordsRetentionService } from './records-retention.service';

describe('RecordsRetentionService', () => {
  const companyId = randomUUID();

  it('audits each table it swept as the system, by count only', async () => {
    const record = jest.fn().mockResolvedValue(undefined);
    const sweepRetention = jest
      .fn()
      .mockResolvedValue([{ companyId, table: 'customers', deleted: 3 }]);
    const service = new RecordsRetentionService(
      { sweepRetention } as unknown as RecordsService,
      { record } as unknown as AuditService,
    );
    const now = new Date('2026-10-12T00:00:00Z');

    await service.sweep(now);

    expect(sweepRetention).toHaveBeenCalledWith(now, expect.any(Function));
    expect(record).toHaveBeenCalledWith(
      companyId,
      'system',
      null,
      'state_change',
      {
        source: 'records',
        action: 'retention_sweep',
        table: 'customers',
        deleted: 3,
      },
    );
  });

  it('never throws, even when the sweep itself fails', async () => {
    const service = new RecordsRetentionService(
      {
        sweepRetention: jest.fn().mockRejectedValue(new Error('db down')),
      } as unknown as RecordsService,
      { record: jest.fn() } as unknown as AuditService,
    );

    await expect(service.sweep()).resolves.toBeUndefined();
  });
});
