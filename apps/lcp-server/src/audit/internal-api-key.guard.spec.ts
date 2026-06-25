import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InternalApiKeyGuard } from './internal-api-key.guard';

function makeContext(headerValue: string | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers:
          headerValue !== undefined
            ? { 'x-internal-api-key': headerValue }
            : {},
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('InternalApiKeyGuard', () => {
  let guard: InternalApiKeyGuard;

  beforeEach(() => {
    const config = {
      getOrThrow: jest.fn().mockReturnValue('secret-key'),
    } as unknown as ConfigService;
    guard = new InternalApiKeyGuard(config);
  });

  it('returns true when the correct key is provided', () => {
    expect(guard.canActivate(makeContext('secret-key'))).toBe(true);
  });

  it('throws UnauthorizedException when the key is wrong', () => {
    expect(() => guard.canActivate(makeContext('wrong-key'))).toThrow(
      UnauthorizedException,
    );
  });

  it('throws UnauthorizedException when the header is absent', () => {
    expect(() => guard.canActivate(makeContext(undefined))).toThrow(
      UnauthorizedException,
    );
  });
});
