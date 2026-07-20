import { UnauthorizedException } from '@nestjs/common';
import { AuthTokenController } from './auth-token.controller';
import {
  AuthTokenService,
  DeviceAuthorizationResponse,
  OidcTokenResponse,
} from './auth-token.service';

describe('AuthTokenController', () => {
  let service: jest.Mocked<
    Pick<
      AuthTokenService,
      'startDeviceAuthorization' | 'pollDeviceToken' | 'refreshToken'
    >
  >;
  let controller: AuthTokenController;

  beforeEach(() => {
    service = {
      startDeviceAuthorization: jest.fn(),
      pollDeviceToken: jest.fn(),
      refreshToken: jest.fn(),
    };
    controller = new AuthTokenController(
      service as unknown as AuthTokenService,
    );
  });

  describe('startDeviceAuthorization', () => {
    it('returns the device authorization response', async () => {
      const response: DeviceAuthorizationResponse = {
        device_code: 'dc-1',
        user_code: 'ABCD-EFGH',
        verification_uri: 'http://localhost:8080/device',
        expires_in: 300,
        interval: 5,
      };
      service.startDeviceAuthorization.mockResolvedValue(response);

      const result = await controller.startDeviceAuthorization();
      expect(result).toEqual(response);
    });
  });

  describe('pollDeviceToken', () => {
    it('returns pending while the flow is incomplete', async () => {
      service.pollDeviceToken.mockResolvedValue({ status: 'pending' });

      const result = await controller.pollDeviceToken({ device_code: 'dc-1' });
      expect(result).toEqual({ status: 'pending' });
      expect(service.pollDeviceToken).toHaveBeenCalledWith('dc-1');
    });

    it('returns the token once complete', async () => {
      service.pollDeviceToken.mockResolvedValue({
        status: 'complete',
        access_token: 'tok123',
        token_type: 'Bearer',
        expires_in: 300,
      });

      const result = await controller.pollDeviceToken({ device_code: 'dc-1' });
      expect(result).toEqual(
        expect.objectContaining({ status: 'complete', access_token: 'tok123' }),
      );
    });

    it('propagates UnauthorizedException from the service', async () => {
      service.pollDeviceToken.mockRejectedValue(
        new UnauthorizedException('expired_token'),
      );
      await expect(
        controller.pollDeviceToken({ device_code: 'dc-1' }),
      ).rejects.toThrow(UnauthorizedException);
    });
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
