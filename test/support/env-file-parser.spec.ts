import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadEnvFileWithLocal, parseEnvFile } from './env-file-parser';

describe('parseEnvFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lcp-env-parse-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('skips comments and blank lines and keeps values containing "="', () => {
    const file = join(dir, '.env');
    writeFileSync(file, '# comment\n\nA=1\nB=x=y=z\n', 'utf8');
    expect(parseEnvFile(file)).toEqual({ A: '1', B: 'x=y=z' });
  });
});

describe('loadEnvFileWithLocal — base + .local layering', () => {
  let dir: string;
  const touched: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lcp-env-local-'));
  });
  afterEach(() => {
    for (const key of touched) delete process.env[key];
    touched.length = 0;
    rmSync(dir, { recursive: true, force: true });
  });

  function base(name: string): string {
    return join(dir, name);
  }

  it('applies the .local override on top of the base (local wins)', () => {
    const file = base('.env.testing');
    writeFileSync(file, 'BASE_ONLY=b\nSHARED=from-base\n', 'utf8');
    writeFileSync(`${file}.local`, 'SHARED=from-local\nLOCAL_ONLY=l\n', 'utf8');
    touched.push('BASE_ONLY', 'SHARED', 'LOCAL_ONLY');

    const merged = loadEnvFileWithLocal(file);

    expect(merged).toEqual({
      BASE_ONLY: 'b',
      SHARED: 'from-local',
      LOCAL_ONLY: 'l',
    });
    expect(process.env.SHARED).toBe('from-local');
    expect(process.env.LOCAL_ONLY).toBe('l');
  });

  it('is a no-op for the override when no .local file exists', () => {
    const file = base('.env.testing');
    writeFileSync(file, 'ONLY_BASE=b\n', 'utf8');
    touched.push('ONLY_BASE');

    const merged = loadEnvFileWithLocal(file);

    expect(merged).toEqual({ ONLY_BASE: 'b' });
    expect(process.env.ONLY_BASE).toBe('b');
  });

  it('never overwrites a value already set in process.env (an explicit export wins)', () => {
    const file = base('.env.testing');
    writeFileSync(file, 'PRESET=from-base\n', 'utf8');
    writeFileSync(`${file}.local`, 'PRESET=from-local\n', 'utf8');
    process.env.PRESET = 'from-export';
    touched.push('PRESET');

    loadEnvFileWithLocal(file);

    expect(process.env.PRESET).toBe('from-export');
  });
});
