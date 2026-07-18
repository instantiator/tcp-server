import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  AuthTokenService,
  DeviceAuthorizationResponse,
  DeviceTokenPollResult,
  OidcTokenResponse,
} from './auth-token.service';

/** Request body for {@link AuthTokenController.pollDeviceToken}. */
interface DeviceTokenRequest {
  device_code: string;
}

/** Request body for {@link AuthTokenController.refreshToken}. */
interface RefreshRequest {
  refresh_token: string;
}

/**
 * Issues OIDC access tokens on behalf of callers.
 * These endpoints are intentionally not guarded — they produce tokens.
 *
 * The OIDC client secret is never exposed to callers; it is resolved
 * server-side from the `OIDC_CLIENT_SECRET` environment variable.
 */
@Controller('api/auth')
export class AuthTokenController {
  constructor(private readonly authTokenService: AuthTokenService) {}

  /**
   * Starts an OAuth 2.0 Device Authorization Grant (RFC 8628). Intended for
   * developer tooling (`lcp-cli get-token`) — the caller presents the
   * returned `verification_uri`/`user_code` to a human to complete login in
   * a browser, then polls {@link pollDeviceToken}.
   */
  @Post('device')
  @HttpCode(HttpStatus.OK)
  async startDeviceAuthorization(): Promise<DeviceAuthorizationResponse> {
    return this.authTokenService.startDeviceAuthorization();
  }

  /**
   * Polls once for the outcome of a device authorization started via
   * {@link startDeviceAuthorization}. Returns `{ status: 'pending' | 'slow_down' }`
   * until the human completes login, then the token response.
   */
  @Post('device/token')
  @HttpCode(HttpStatus.OK)
  async pollDeviceToken(
    @Body() body: DeviceTokenRequest,
  ): Promise<DeviceTokenPollResult> {
    return this.authTokenService.pollDeviceToken(body.device_code);
  }

  /**
   * Exchanges a refresh token for a new access token.
   * The OIDC client secret is resolved server-side and never exposed to callers.
   */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refreshToken(@Body() body: RefreshRequest): Promise<OidcTokenResponse> {
    return this.authTokenService.refreshToken(body.refresh_token);
  }
}
