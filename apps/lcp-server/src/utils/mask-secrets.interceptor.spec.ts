import { ExecutionContext, CallHandler } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { of, lastValueFrom } from 'rxjs';
import { MaskSecretsInterceptor } from './mask-secrets.interceptor';

function makeInterceptor(mask: boolean) {
  const config = {
    get: jest.fn().mockReturnValue(mask),
  } as unknown as ConfigService;
  return new MaskSecretsInterceptor(config);
}

function makeHandler(value: unknown): CallHandler {
  return { handle: () => of(value) };
}

async function intercept(mask: boolean, value: unknown): Promise<unknown> {
  const interceptor = makeInterceptor(mask);
  const stream = interceptor.intercept(
    {} as ExecutionContext,
    makeHandler(value),
  );
  return lastValueFrom(stream);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

describe('MaskSecretsInterceptor', () => {
  it('replaces apiKey strings with *** when masking is enabled', async () => {
    const result = asRecord(
      await intercept(true, {
        llmConfig: { provider: 'openai', apiKey: 'test-secret-key' },
      }),
    );
    const llmConfig = asRecord(result['llmConfig']);
    expect(llmConfig['apiKey']).toBe('***');
    expect(llmConfig['provider']).toBe('openai');
  });

  it('passes apiKey through unchanged when masking is disabled', async () => {
    const result = asRecord(
      await intercept(false, { apiKey: 'test-secret-key' }),
    );
    expect(result['apiKey']).toBe('test-secret-key');
  });

  it('masks apiKey nested inside an array of objects', async () => {
    const result = (await intercept(true, [
      { apiKey: 'key-alpha' },
      { apiKey: 'key-beta' },
    ])) as Record<string, unknown>[];
    expect(result[0]['apiKey']).toBe('***');
    expect(result[1]['apiKey']).toBe('***');
  });

  it('leaves non-apiKey fields at any depth unchanged', async () => {
    const result = asRecord(
      await intercept(true, { a: { b: { c: 'value' } } }),
    );
    const a = asRecord(result['a']);
    const b = asRecord(a['b']);
    expect(b['c']).toBe('value');
  });

  it('leaves null values unchanged', async () => {
    const result = asRecord(await intercept(true, { llmConfig: null }));
    expect(result['llmConfig']).toBeNull();
  });
});
