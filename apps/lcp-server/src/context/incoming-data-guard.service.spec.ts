import { AIMessage } from '@langchain/core/messages';

jest.mock('@langchain/core/utils/tiktoken', () => ({
  getEncoding: jest.fn().mockResolvedValue({
    // Each character = 1 token for predictable test assertions
    encode: (text: string) => new Uint32Array(text.length),
  }),
}));

import { ContextBudgetService } from './context-budget.service';
import { ContextCompactorService } from './context-compactor.service';
import { IncomingDataGuardService } from './incoming-data-guard.service';
import type { MinioService } from '../storage/minio.service';

function makeServices() {
  const budget = new ContextBudgetService();
  const compactor = new ContextCompactorService(budget);
  return { budget, compactor };
}

describe('IncomingDataGuardService', () => {
  let budget: ContextBudgetService;
  let compactor: ContextCompactorService;
  let service: IncomingDataGuardService;
  let model: { invoke: jest.Mock };
  let compactSectionSpy: jest.SpyInstance;

  beforeEach(() => {
    ({ budget, compactor } = makeServices());
    compactSectionSpy = jest.spyOn(compactor, 'compactSection');
    service = new IncomingDataGuardService(budget, compactor);
    model = { invoke: jest.fn() };
    jest.clearAllMocks();
  });

  it('passes through text that fits within budget', async () => {
    // Window = 1000, current = 100, incoming = 100 → total 200 = 20% (under 80%)
    const result = await service.check(
      'a'.repeat(100),
      100,
      1000,
      model as never,
    );

    expect(result.compacted).toBe(false);
    expect(result.text).toBe('a'.repeat(100));
    expect(compactSectionSpy).not.toHaveBeenCalled();
  });

  it('compacts text when the incoming data would push context over budget', async () => {
    (compactor.compactSection as jest.Mock).mockResolvedValue('short summary');
    model.invoke.mockResolvedValue(new AIMessage('short summary'));

    // Window = 1000, current = 700, incoming = 200 → total 900 = 90% (over 80%)
    const result = await service.check(
      'a'.repeat(200),
      700,
      1000,
      model as never,
    );

    expect(result.compacted).toBe(true);
    expect(result.text).toBe('short summary');
    expect(result.activity).toBeDefined();
  });

  it('returns compacted text even when still over budget (best effort, no MinioService)', async () => {
    // compact returns something still large
    (compactor.compactSection as jest.Mock).mockResolvedValue('b'.repeat(300));
    model.invoke.mockResolvedValue(new AIMessage('b'.repeat(300)));

    // Window = 1000, current = 750, incoming = 400 → total 1150 = 115% (over 80%)
    // After compact: current + 300 = 1050 = 105% — still over
    const result = await service.check(
      'a'.repeat(400),
      750,
      1000,
      model as never,
    );

    expect(result.compacted).toBe(true);
    expect(result.activity).toContain('still over budget');
    expect(result.overflowKey).toBeUndefined();
  });

  it('stores overflow in MinIO and returns reference when still over budget', async () => {
    const putRaw = jest.fn().mockResolvedValue(undefined);
    const minio = { putRaw } as unknown as MinioService;
    const serviceWithMinio = new IncomingDataGuardService(
      budget,
      compactor,
      minio,
    );
    (compactor.compactSection as jest.Mock).mockResolvedValue('b'.repeat(300));

    const result = await serviceWithMinio.check(
      'a'.repeat(400),
      750,
      1000,
      model as never,
      'acme/tasks/agent-1/context-overflow',
    );

    expect(putRaw).toHaveBeenCalledWith(
      expect.stringContaining('acme/tasks/agent-1/context-overflow/'),
      'a'.repeat(400),
    );
    expect(result.compacted).toBe(true);
    expect(result.overflowKey).toBeDefined();
    expect(result.text).toContain('[Context overflow:');
  });

  it('falls back to best-effort compaction when MinIO write fails', async () => {
    const putRaw = jest.fn().mockRejectedValue(new Error('MinIO unreachable'));
    const minio = { putRaw } as unknown as MinioService;
    const serviceWithMinio = new IncomingDataGuardService(
      budget,
      compactor,
      minio,
    );
    (compactor.compactSection as jest.Mock).mockResolvedValue('b'.repeat(300));

    const result = await serviceWithMinio.check(
      'a'.repeat(400),
      750,
      1000,
      model as never,
      'acme/tasks/agent-1/context-overflow',
    );

    expect(result.compacted).toBe(true);
    expect(result.overflowKey).toBeUndefined();
    expect(result.activity).toContain('still over budget');
  });
});
