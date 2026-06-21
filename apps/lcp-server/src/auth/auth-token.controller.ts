import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { AuthTokenService, OidcTokenResponse } from './auth-token.service';

/** Request body for {@link AuthTokenController.getToken}. */
interface TokenRequest {
  username: string;
  password: string;
}

/** Request body for {@link AuthTokenController.refreshToken}. */
interface RefreshRequest {
  refresh_token: string;
}

/**
 * Issues OIDC access tokens on behalf of callers.
 * This endpoint is intentionally not guarded — it produces tokens.
 *
 * The OIDC client secret is never exposed to callers; it is resolved
 * server-side from the `OIDC_CLIENT_SECRET` environment variable.
 */
@Controller('api/auth')
export class AuthTokenController {
  constructor(private readonly authTokenService: AuthTokenService) {}

  /**
   * Exchanges a username and password for an OIDC access token using the
   * Resource Owner Password Credentials grant.
   *
   * Intended for developer tooling (CLI) — not for production user-facing flows.
   */
  @Post('token')
  @HttpCode(HttpStatus.OK)
  async getToken(@Body() body: TokenRequest): Promise<OidcTokenResponse> {
    return this.authTokenService.getToken(body.username, body.password);
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
