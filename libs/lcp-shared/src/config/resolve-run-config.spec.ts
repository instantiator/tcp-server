import type { LcpCompany } from '../models/LcpCompany.model';
import type { LcpRole } from '../models/LcpRole.model';
import { resolveRunConfig } from './resolve-run-config';

const role = (maxIterations?: number): LcpRole =>
  ({
    runConfig: maxIterations !== undefined ? { maxIterations } : null,
  }) as LcpRole;

const company = (maxIterations?: number): LcpCompany =>
  ({
    runConfig: maxIterations !== undefined ? { maxIterations } : null,
  }) as LcpCompany;

describe('resolveRunConfig', () => {
  it('uses the role value when set', () => {
    expect(
      resolveRunConfig('maxIterations', role(5), company(20), 30, 10),
    ).toBe(5);
  });

  it('falls through to company when role has no runConfig', () => {
    expect(resolveRunConfig('maxIterations', role(), company(20), 30, 10)).toBe(
      20,
    );
  });

  it('falls through to env value when neither role nor company is set', () => {
    expect(resolveRunConfig('maxIterations', role(), company(), 30, 10)).toBe(
      30,
    );
  });

  it('falls through to default when no override is set', () => {
    expect(
      resolveRunConfig('maxIterations', role(), company(), undefined, 10),
    ).toBe(10);
  });

  it('treats null role and company the same as no runConfig', () => {
    expect(resolveRunConfig('maxIterations', null, null, undefined, 10)).toBe(
      10,
    );
  });
});
