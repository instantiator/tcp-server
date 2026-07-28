import { apiRequest, ApiOptions } from '../core/api';

/** Options that control how a token is obtained. */
export interface AuthOptions {
  baseUrl: string;
  accessToken?: string;
  refreshToken?: string;
  accessTokenEnvVar?: string;
  /** Skip the TCP_TOKEN cache and always trigger device login. */
  force?: boolean;
}

/** A resolved token pair. `refreshToken` is only present when obtained via device login. */
export interface TokenSession {
  token: string;
  refreshToken?: string;
}

/** Env var `get-token`'s docs/examples conventionally capture the token into — checked as a fallback when neither `-t` nor `-E` is given. */
const DEFAULT_TOKEN_ENV_VAR = 'TCP_TOKEN';

/** Response shape of `POST /api/auth/device`. */
interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

/** Response shape of `POST /api/auth/device/token`: pending, or a resolved token. */
interface DeviceTokenPollResult {
  status?: 'pending' | 'slow_down';
  access_token?: string;
  refresh_token?: string;
}

/** Resolves a bearer token and, when possible, a refresh token. */
export async function resolveSession(opts: AuthOptions): Promise<TokenSession> {
  // 1. Explicit token
  if (opts.accessToken)
    return { token: opts.accessToken, refreshToken: opts.refreshToken };

  // 2. Environment variable (explicit name) — unset is a hard error, since the
  // caller asked for this var by name.
  if (opts.accessTokenEnvVar) {
    const val = process.env[opts.accessTokenEnvVar];
    if (!val) {
      process.stderr.write(
        `Error: env var ${opts.accessTokenEnvVar} is not set\n`,
      );
      process.exit(1);
    }
    return { token: val, refreshToken: opts.refreshToken };
  }

  // 3. TCP_TOKEN fallback — skip when --force is set or the cached token is
  // expired. An expired token would only cause a 401 on the first API call,
  // so we save the round-trip by re-authenticating proactively.
  const fallback = process.env[DEFAULT_TOKEN_ENV_VAR];
  if (fallback) {
    if (opts.force) {
      process.stderr.write(
        'Ignoring cached token (--force): re-authenticating\n',
      );
    } else if (isExpired(fallback)) {
      process.stderr.write('Cached token is expired — re-authenticating\n');
    } else {
      process.stderr.write(
        'Using existing token from TCP_TOKEN. Run `get-token --force` to re-authenticate.\n',
      );
      return { token: fallback, refreshToken: opts.refreshToken };
    }
  }

  // 4. OAuth 2.0 Device Authorization Grant (RFC 8628) — the OIDC provider
  // doesn't support a password grant, so login happens in a browser.
  return deviceLogin(opts.baseUrl);
}

/**
 * Starts a device-authorization login via the server proxy, prints the
 * verification URL and code for the user to complete in a browser, then
 * polls until they do (or the code expires) — the same pattern `gh auth
 * login` / `docker login` use.
 */
async function deviceLogin(baseUrl: string): Promise<TokenSession> {
  const apiOpts: ApiOptions = { baseUrl };
  const device = await apiRequest<DeviceAuthorizationResponse>(
    apiOpts,
    'POST',
    '/api/auth/device',
  );

  process.stderr.write(
    `To sign in, open ${device.verification_uri} and enter code: ${device.user_code}\n`,
  );
  if (device.verification_uri_complete) {
    process.stderr.write(
      `Or open directly: ${device.verification_uri_complete}\n`,
    );
  }

  const deadline = Date.now() + device.expires_in * 1000;
  let intervalMs = device.interval * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const result = await apiRequest<DeviceTokenPollResult>(
      apiOpts,
      'POST',
      '/api/auth/device/token',
      { device_code: device.device_code },
    );
    if (result.access_token) {
      return { token: result.access_token, refreshToken: result.refresh_token };
    }
    if (result.status === 'slow_down') intervalMs += 5_000;
  }

  process.stderr.write('Error: device login timed out — please try again\n');
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves a bearer token from the provided options, prompting if needed. */
export async function resolveToken(opts: AuthOptions): Promise<string> {
  return (await resolveSession(opts)).token;
}

/**
 * Exchanges a refresh token for a new access token via the server proxy.
 * The OIDC client secret never leaves the server. Returns the server's
 * rotated refresh token when it issues one — some OIDC providers invalidate
 * the old refresh token on use, so dropping a rotated one would strand
 * {@link TokenManager} after its very next refresh.
 */
export async function renewToken(
  baseUrl: string,
  refreshToken: string,
): Promise<TokenSession> {
  const data = await apiRequest<{
    access_token: string;
    refresh_token?: string;
  }>({ baseUrl }, 'POST', '/api/auth/refresh', { refresh_token: refreshToken });
  return {
    token: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
  };
}

/** Whether the token is a JWT whose `exp` claim is in the past. Returns `false` for non-JWT tokens (we can't tell). */
function isExpired(token: string): boolean {
  const expiryMs = decodeExpiryMs(token);
  return expiryMs !== undefined && expiryMs < Date.now();
}

/** Seconds of headroom to refresh ahead of a token's `exp` claim. */
const REFRESH_MARGIN_MS = 30_000;
/** Refresh interval used when a token's `exp` claim can't be read. */
const FALLBACK_REFRESH_MS = 4 * 60_000;

/**
 * Reads a JWT's unverified `exp` claim (seconds since epoch), or `undefined`
 * if the token isn't a JWT or has no `exp`. Unverified is fine here — this
 * only paces the CLI's own background refresh timer for a token it already
 * trusts (obtained via its own auth flow), never an authorization decision.
 */
function decodeExpiryMs(token: string): number | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const { exp } = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as { exp?: number };
    return typeof exp === 'number' ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** Whether an error thrown by `apiRequest` reports an HTTP 401. */
function isUnauthorized(err: unknown): boolean {
  return err instanceof Error && err.message.includes('HTTP 401');
}

/**
 * Owns one session's access token, refreshing it in the background —
 * shortly ahead of its `exp` claim, or every {@link FALLBACK_REFRESH_MS} when
 * that can't be read — whenever a refresh token is available. Long-running
 * commands (`chat`, `tui`, `eavesdrop --tail`) previously held a single
 * token fixed for the session's lifetime, so any request or stream made
 * after it expired failed with an "unauthorised" 401.
 */
export class TokenManager {
  private token: string;
  private refreshToken?: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly baseUrl: string,
    tokens: TokenSession,
  ) {
    this.token = tokens.token;
    this.refreshToken = tokens.refreshToken;
    this.scheduleRefresh();
  }

  /** The current access token. */
  get current(): string {
    return this.token;
  }

  /**
   * Performs an authenticated `apiRequest`, retrying once — after forcing a
   * refresh — on a 401. A reactive fallback for whenever the background
   * timer didn't get there first (e.g. the server's token lifetime is
   * shorter than expected).
   */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      return await apiRequest<T>(
        { baseUrl: this.baseUrl, token: this.token, signal },
        method,
        path,
        body,
      );
    } catch (err) {
      if (!isUnauthorized(err) || !this.refreshToken) throw err;
      await this.forceRefresh();
      return apiRequest<T>(
        { baseUrl: this.baseUrl, token: this.token, signal },
        method,
        path,
        body,
      );
    }
  }

  /** Stops the background refresh timer — call once the session ends. */
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Refreshes now, coalescing with any refresh already in flight (the timer and a 401 retry can race here). No-op without a refresh token. */
  private async forceRefresh(): Promise<void> {
    if (!this.refreshToken) return;
    if (!this.refreshing) {
      this.refreshing = this.refresh().finally(() => {
        this.refreshing = null;
      });
    }
    await this.refreshing;
  }

  private async refresh(): Promise<void> {
    if (!this.refreshToken) return;
    try {
      const session = await renewToken(this.baseUrl, this.refreshToken);
      this.token = session.token;
      this.refreshToken = session.refreshToken ?? this.refreshToken;
    } finally {
      // Reschedule even on failure — the fallback interval gives the next
      // tick a chance to recover from a transient error.
      this.scheduleRefresh();
    }
  }

  private scheduleRefresh(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.refreshToken) return;
    const expiryMs = decodeExpiryMs(this.token);
    const delayMs = expiryMs
      ? Math.max(expiryMs - Date.now() - REFRESH_MARGIN_MS, 1_000)
      : FALLBACK_REFRESH_MS;
    this.timer = setTimeout(() => void this.forceRefresh(), delayMs);
    this.timer.unref();
  }
}
