import { UnauthorizedException } from '@nestjs/common';
import { AuthTokenController } from './auth-token.controller';
import { AuthTokenService, OidcTokenResponse } from './auth-token.service';

describe('AuthTokenController', () => {
  let service: jest.Mocked<Pick<AuthTokenService, 'getToken'>>;
  let controller: AuthTokenController;

  beforeEach(() => {
    service = { getToken: jest.fn() };
    controller = new AuthTokenController(
      service as unknown as AuthTokenService,
    );
  });

  it('returns the token response on success', async () => {
    const tokenResponse: OidcTokenResponse = {
      access_token: 'tok123',
      token_type: 'Bearer',
      expires_in: 300,
    };
    service.getToken.mockResolvedValue(tokenResponse);

    const result = await controller.getToken({
      username: 'alice',
      password: 'secret',
    });
    expect(result.access_token).toBe('tok123');
    expect(service.getToken).toHaveBeenCalledWith('alice', 'secret');
  });

  it('propagates UnauthorizedException from the service', async () => {
    service.getToken.mockRejectedValue(
      new UnauthorizedException('Invalid credentials or OIDC error'),
    );
    await expect(
      controller.getToken({ username: 'alice', password: 'wrong' }),
    ).rejects.toThrow(UnauthorizedException);
  });
});
