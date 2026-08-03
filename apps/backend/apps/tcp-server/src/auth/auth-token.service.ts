import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Shape of a successful OIDC token response. */
export interface OidcTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
}

/** Shape of a successful device authorization response (RFC 8628). */
export interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

/** Result of one device-token poll: either the flow isn't done yet, or it is. */
export type DeviceTokenPollResult =
  | { status: 'pending' | 'slow_down' }
  | ({ status: 'complete' } & OidcTokenResponse);

/** Shape of the OIDC discovery document (subset we care about). */
interface OidcDiscovery {
  issuer: string;
  token_endpoint: string;
  device_authorization_endpoint?: string;
}

/** RFC 8628 error responses that mean "not done yet, keep polling". */
const DEVICE_POLL_PENDING_ERRORS = new Set([
  'authorization_pending',
  'slow_down',
]);

/**
 * Proxies OIDC token exchanges to the configured provider. The OIDC client
 * secret never leaves the server.
 *
 * The discovery document is fetched once on first use and cached in memory
 * for the lifetime of the service.
 */
@Injectable()
export class AuthTokenService {
  private readonly logger = new Logger(AuthTokenService.name);
  private endpoints: {
    tokenEndpoint: string;
    deviceAuthorizationEndpoint?: string;
  } | null = null;

  constructor(private readonly config: ConfigService) {}

  /**
   * Starts an OAuth 2.0 Device Authorization Grant (RFC 8628). The caller
   * presents `verification_uri`/`user_code` to a human, who completes login
   * in a browser, then polls {@link pollDeviceToken} with the `device_code`.
   */
  async startDeviceAuthorization(): Promise<DeviceAuthorizationResponse> {
    const { deviceAuthorizationEndpoint } = await this.resolveEndpoints();
    if (!deviceAuthorizationEndpoint) {
      throw new Error(
        'OIDC provider does not advertise a device_authorization_endpoint',
      );
    }

    const res = await fetch(deviceAuthorizationEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...this.forwardedHostHeader(),
      },
      body: new URLSearchParams({
        client_id: this.config.getOrThrow<string>('OIDC_CLIENT_ID'),
        client_secret: this.config.getOrThrow<string>('OIDC_CLIENT_SECRET'),
        scope: 'openid profile offline_access',
      }).toString(),
    });

    if (!res.ok) {
      throw new Error(
        `Device authorization request failed: HTTP ${res.status}`,
      );
    }
    return (await res.json()) as DeviceAuthorizationResponse;
  }

  /**
   * Polls the token endpoint once for a device code obtained from
   * {@link startDeviceAuthorization}. Returns `{ status: 'pending' | 'slow_down' }`
   * while the human hasn't finished logging in yet; throws once the flow
   * fails outright (denied or expired).
   */
  async pollDeviceToken(deviceCode: string): Promise<DeviceTokenPollResult> {
    const { tokenEndpoint } = await this.resolveEndpoints();

    const res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...this.forwardedHostHeader(),
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: this.config.getOrThrow<string>('OIDC_CLIENT_ID'),
        client_secret: this.config.getOrThrow<string>('OIDC_CLIENT_SECRET'),
        device_code: deviceCode,
      }).toString(),
    });

    if (res.ok) {
      const data = (await res.json()) as OidcTokenResponse;
      return { status: 'complete', ...data };
    }

    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (body.error && DEVICE_POLL_PENDING_ERRORS.has(body.error)) {
      return { status: body.error === 'slow_down' ? 'slow_down' : 'pending' };
    }
    this.logger.warn(
      `Device token poll failed: HTTP ${res.status} (${body.error ?? 'unknown'})`,
    );
    throw new UnauthorizedException(
      body.error ?? 'Device authorization failed',
    );
  }

  /** Exchanges a refresh token for a new access token. */
  async refreshToken(refreshToken: string): Promise<OidcTokenResponse> {
    const { tokenEndpoint } = await this.resolveEndpoints();

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.config.getOrThrow<string>('OIDC_CLIENT_ID'),
      client_secret: this.config.getOrThrow<string>('OIDC_CLIENT_SECRET'),
      refresh_token: refreshToken,
    });

    const res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...this.forwardedHostHeader(),
      },
      body: body.toString(),
    });

    if (!res.ok) {
      this.logger.warn(`OIDC refresh request failed: HTTP ${res.status}`);
      throw new UnauthorizedException('Refresh token invalid or expired');
    }

    return (await res.json()) as OidcTokenResponse;
  }

  /**
   * `Host`-based instance routing (e.g. Zitadel) rejects requests reached via
   * an internal Docker network address whose Host header doesn't match the
   * provider's configured external domain. Forwarding the real external host
   * lets the provider resolve the right instance while the request still
   * travels over the internal network. Harmless no-op for providers reached
   * directly (internal and external host already match) or that ignore it.
   */
  private forwardedHostHeader(): Record<string, string> {
    const issuerUrl = this.config.getOrThrow<string>('OIDC_ISSUER_URL');
    return { 'X-Forwarded-Host': new URL(issuerUrl).host };
  }

  /** Fetches the token/device-authorization endpoints from the OIDC discovery document (cached after first call). */
  private async resolveEndpoints(): Promise<{
    tokenEndpoint: string;
    deviceAuthorizationEndpoint?: string;
  }> {
    if (this.endpoints) return this.endpoints;

    const issuer = (
      this.config.get<string>('OIDC_INTERNAL_ISSUER_URL') ??
      this.config.getOrThrow<string>('OIDC_ISSUER_URL')
    ).replace(/\/$/, '');
    const discoveryUrl = `${issuer}/.well-known/openid-configuration`;

    const res = await fetch(discoveryUrl, {
      headers: this.forwardedHostHeader(),
    });
    if (!res.ok) {
      throw new Error(
        `OIDC discovery failed: HTTP ${res.status} from ${discoveryUrl}`,
      );
    }

    const doc = (await res.json()) as OidcDiscovery;

    // Any provider that advertises a different public hostname (e.g. Zitadel's
    // ExternalDomain, Keycloak's KC_HOSTNAME) returns external URLs in the
    // discovery doc even when fetched via the internal host. Rebase onto the
    // internal issuer so the endpoints stay reachable over the internal network.
    const advertisedIssuer = doc.issuer.replace(/\/$/, '');
    const rebase = (url: string) =>
      url.startsWith(advertisedIssuer)
        ? issuer + url.slice(advertisedIssuer.length)
        : url;

    this.endpoints = {
      tokenEndpoint: rebase(doc.token_endpoint),
      deviceAuthorizationEndpoint: doc.device_authorization_endpoint
        ? rebase(doc.device_authorization_endpoint)
        : undefined,
    };

    this.logger.log(
      `OIDC token endpoint resolved: ${this.endpoints.tokenEndpoint}`,
    );
    return this.endpoints;
  }
}
