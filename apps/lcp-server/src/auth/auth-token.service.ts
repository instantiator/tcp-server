import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Shape of a successful OIDC token response. */
export interface OidcTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

/** Shape of the OIDC discovery document (subset we care about). */
interface OidcDiscovery {
  issuer: string;
  token_endpoint: string;
}

/**
 * Proxies username/password credentials to the configured OIDC provider and
 * returns an access token. The OIDC client secret never leaves the server.
 *
 * The discovery document is fetched once on first use and cached in memory
 * for the lifetime of the service.
 */
@Injectable()
export class AuthTokenService {
  private readonly logger = new Logger(AuthTokenService.name);
  private tokenEndpoint: string | null = null;

  constructor(private readonly config: ConfigService) {}

  /** Exchanges username + password for an OIDC access token via the password grant. */
  async getToken(
    username: string,
    password: string,
  ): Promise<OidcTokenResponse> {
    const endpoint = await this.resolveTokenEndpoint();

    const body = new URLSearchParams({
      grant_type: 'password',
      client_id: this.config.getOrThrow<string>('OIDC_CLIENT_ID'),
      client_secret: this.config.getOrThrow<string>('OIDC_CLIENT_SECRET'),
      username,
      password,
    });

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      this.logger.warn(`OIDC token request failed: HTTP ${res.status}`);
      throw new UnauthorizedException('Invalid credentials or OIDC error');
    }

    const data = (await res.json()) as OidcTokenResponse;
    return data;
  }

  /** Fetches the token endpoint from the OIDC discovery document (cached after first call). */
  private async resolveTokenEndpoint(): Promise<string> {
    if (this.tokenEndpoint) return this.tokenEndpoint;

    const issuer = (
      this.config.get<string>('OIDC_INTERNAL_ISSUER_URL') ??
      this.config.getOrThrow<string>('OIDC_ISSUER_URL')
    ).replace(/\/$/, '');
    const discoveryUrl = `${issuer}/.well-known/openid-configuration`;

    const res = await fetch(discoveryUrl);
    if (!res.ok) {
      throw new Error(
        `OIDC discovery failed: HTTP ${res.status} from ${discoveryUrl}`,
      );
    }

    const doc = (await res.json()) as OidcDiscovery;

    // KC_HOSTNAME (or any provider that advertises a different public hostname) causes
    // the discovery doc to return external URLs even when fetched via the internal host.
    // Rebase the token_endpoint onto the internal issuer so the request stays on the
    // internal network.
    const advertisedIssuer = doc.issuer.replace(/\/$/, '');
    this.tokenEndpoint = doc.token_endpoint.startsWith(advertisedIssuer)
      ? issuer + doc.token_endpoint.slice(advertisedIssuer.length)
      : doc.token_endpoint;

    this.logger.log(`OIDC token endpoint resolved: ${this.tokenEndpoint}`);
    return this.tokenEndpoint;
  }
}
