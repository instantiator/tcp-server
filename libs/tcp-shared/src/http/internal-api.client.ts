import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

/**
 * HTTP client for tcp-server's `/internal/*` endpoints, authenticating with
 * the shared internal API key.
 *
 * Used by tcp-agent and all four MCP services, which would otherwise each
 * repeat the same config lookup and `X-Internal-Api-Key` header literal.
 *
 * {@link InternalApiClient.get} and {@link InternalApiClient.post} propagate
 * errors so callers can relay a corrective 4xx to the model; the `*AndForget`
 * variants never throw, for writes that must not interrupt a run.
 */
@Injectable()
export class InternalApiClient {
  private readonly logger = new Logger(InternalApiClient.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(config: ConfigService) {
    this.baseUrl = config.getOrThrow<string>('TCP_SERVER_URL');
    this.apiKey = config.getOrThrow<string>('INTERNAL_API_KEY');
  }

  /**
   * @param path - Server-absolute path, e.g. `/internal/agent/:id/assignment`.
   * @throws {AxiosError} on any non-2xx response or transport failure.
   */
  async get<T>(path: string): Promise<T> {
    const res = await axios.get<T>(this.url(path), { headers: this.headers() });
    return res.data;
  }

  /**
   * @param path - Server-absolute path, e.g. `/internal/storage/read`.
   * @throws {AxiosError} on any non-2xx response or transport failure.
   */
  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await axios.post<T>(this.url(path), body, {
      headers: this.headers(),
    });
    return res.data;
  }

  /**
   * Posts without awaiting the result. Failures are logged and swallowed.
   *
   * @param context - Names the operation in the warning logged on failure.
   */
  postAndForget(path: string, body: unknown, context: string): void {
    this.forget(
      axios.post(this.url(path), body, { headers: this.headers() }),
      context,
    );
  }

  /**
   * Patches without awaiting the result. Failures are logged and swallowed.
   *
   * @param context - Names the operation in the warning logged on failure.
   */
  patchAndForget(path: string, body: unknown, context: string): void {
    this.forget(
      axios.patch(this.url(path), body, { headers: this.headers() }),
      context,
    );
  }

  /** Swallows a fire-and-forget request's failure, leaving a warning behind. */
  private forget(request: Promise<unknown>, context: string): void {
    request.catch((err: unknown) => {
      this.logger.warn(
        `${context} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private headers(): Record<string, string> {
    return { 'X-Internal-Api-Key': this.apiKey };
  }
}
