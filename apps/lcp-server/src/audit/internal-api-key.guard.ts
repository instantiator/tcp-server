import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

/**
 * Guards internal endpoints by comparing the `X-Internal-Api-Key` request header
 * against the `INTERNAL_API_KEY` environment variable.
 *
 * Returns 401 when the header is absent, 403 when the key is present but wrong.
 * This provides lightweight authentication for service-to-service calls within
 * the Docker Compose network. Not a substitute for JWT auth — see ADR-011.
 */
@Injectable()
export class InternalApiKeyGuard implements CanActivate {
  private readonly expectedKey: string;

  constructor(config: ConfigService) {
    this.expectedKey = config.getOrThrow<string>('INTERNAL_API_KEY');
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.headers['x-internal-api-key'];
    if (!provided)
      throw new UnauthorizedException('X-Internal-Api-Key header is required');
    if (provided !== this.expectedKey)
      throw new ForbiddenException('Invalid internal API key');
    return true;
  }
}
