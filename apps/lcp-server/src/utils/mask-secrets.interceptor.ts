import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * Recursively replaces `apiKey` values in the response body with `'***'`
 * when the `LCP_MASK_API_KEYS` environment variable is `true` (the default).
 * Set `LCP_MASK_API_KEYS=false` to expose raw keys, e.g. during local debugging.
 */
@Injectable()
export class MaskSecretsInterceptor implements NestInterceptor {
  private readonly mask: boolean;

  constructor(config: ConfigService) {
    this.mask = config.get<boolean>('LCP_MASK_API_KEYS') ?? true;
  }

  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.mask) return next.handle();
    return next.handle().pipe(map((value) => maskApiKeys(value)));
  }
}

/** Recursively walks a plain value and replaces any `apiKey` string with `'***'`. */
function maskApiKeys(value: unknown): unknown {
  // A Date has no own enumerable properties, so walking it via Object.entries
  // below would silently collapse it to `{}` — it can't hold an apiKey, so
  // just pass it through untouched (JSON.stringify still renders it as its
  // ISO string later).
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(maskApiKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) =>
        k === 'apiKey' && typeof v === 'string'
          ? [k, '***']
          : [k, maskApiKeys(v)],
      ),
    );
  }
  return value;
}
