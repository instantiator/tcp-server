import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeEnvFile } from './env-writer';
import { LOCAL_ONLY_ENV_KEYS } from './app-defaults';
import type { WizardConfig } from '../types';

/** Minimal wizard config; override fields per test. */
function makeConfig(overrides: Partial<WizardConfig> = {}): WizardConfig {
  return {
    instanceName: 'test-instance',
    envFileName: '.env.testinstance',
    ports: {
      api: 3000,
      db: 5432,
      minio: 9000,
      minioConsole: 9001,
      zitadel: 8080,
    },
    agentIterations: 40,
    agentConcurrency: 1,
    docker: {
      postgres: true,
      redis: true,
      minio: true,
      zitadel: true,
      stubLlm: true,
    },
    ...overrides,
  };
}

/** Keys assigned on non-comment `KEY=value` lines. */
function uncommentedKeys(content: string): Set<string> {
  const keys = new Set<string>();
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq > 0) keys.add(line.slice(0, eq).trim());
  }
  return keys;
}

/** Value of an uncommented `KEY=value` line, or undefined. */
function valueOf(content: string, key: string): string | undefined {
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1);
  }
  return undefined;
}

describe('writeEnvFile — committed base vs gitignored .local split', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lcp-env-writer-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('never writes the local-only (client credential) keys into the committed base file', () => {
    const { envFile } = writeEnvFile(makeConfig(), dir);
    const base = uncommentedKeys(readFileSync(envFile, 'utf8'));
    for (const key of LOCAL_ONLY_ENV_KEYS) {
      expect(base.has(key)).toBe(false);
    }
  });

  it('leaves the .local override for the bootstrap to fill when using the bundled Zitadel', () => {
    const { localFile } = writeEnvFile(makeConfig(), dir);
    const local = uncommentedKeys(readFileSync(localFile, 'utf8'));
    // No client creds yet — start-deployment.sh writes them on first run.
    for (const key of LOCAL_ONLY_ENV_KEYS) {
      expect(local.has(key)).toBe(false);
    }
  });

  it('writes external-provider OIDC client credentials to .local, not the base file', () => {
    const config = makeConfig({
      oidc: {
        issuerUrl: 'https://idp.example.com',
        clientId: 'ext-client-id',
        clientSecret: 'ext-secret',
      },
    });
    const { envFile, localFile } = writeEnvFile(config, dir);
    const baseContent = readFileSync(envFile, 'utf8');
    const localContent = readFileSync(localFile, 'utf8');

    // Issuer URL (non-secret) is committed; secrets are not.
    expect(valueOf(baseContent, 'OIDC_ISSUER_URL')).toBe(
      'https://idp.example.com',
    );
    expect(uncommentedKeys(baseContent).has('OIDC_CLIENT_SECRET')).toBe(false);
    // Client credentials land in the gitignored override.
    expect(valueOf(localContent, 'OIDC_CLIENT_ID')).toBe('ext-client-id');
    expect(valueOf(localContent, 'OIDC_CLIENT_SECRET')).toBe('ext-secret');
  });

  it('preserves existing .local values (e.g. bootstrap-written TEST_CLIENT_*) on re-run', () => {
    const localPath = join(dir, '.env.testinstance.local');
    writeFileSync(
      localPath,
      'TEST_CLIENT_ID=machine-123\nTEST_CLIENT_SECRET=kept-secret\n',
      'utf8',
    );
    const { localFile } = writeEnvFile(makeConfig(), dir);
    const local = readFileSync(localFile, 'utf8');
    expect(valueOf(local, 'TEST_CLIENT_ID')).toBe('machine-123');
    expect(valueOf(local, 'TEST_CLIENT_SECRET')).toBe('kept-secret');
  });
});
