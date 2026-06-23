import { UnauthorizedException } from '@nestjs/common';
import { AuthTokenController } from './auth-token.controller';
import { AuthTokenService, OidcTokenResponse } from './auth-token.service';

describe('AuthTokenController', () => {
  let service: jest.Mocked<Pick<AuthTokenService, 'getToken' | 'refreshToken'>>;
  let controller: AuthTokenController;

  beforeEach(() => {
    service = { getToken: jest.fn(), refreshToken: jest.fn() };
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

  describe('refreshToken', () => {
    it('delegates to the service and returns the token response', async () => {
      const tokenResponse: OidcTokenResponse = {
        access_token: 'new-tok',
        token_type: 'Bearer',
        expires_in: 300,
        refresh_token: 'new-refresh',
      };
      service.refreshToken.mockResolvedValue(tokenResponse);

      const result = await controller.refreshToken({
        refresh_token: 'old-refresh',
      });

      expect(result.access_token).toBe('new-tok');
      expect(service.refreshToken).toHaveBeenCalledWith('old-refresh');
    });

    it('propagates UnauthorizedException when the refresh token is invalid', async () => {
      service.refreshToken.mockRejectedValue(
        new UnauthorizedException('Refresh token invalid or expired'),
      );
      await expect(
        controller.refreshToken({ refresh_token: 'expired' }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});
