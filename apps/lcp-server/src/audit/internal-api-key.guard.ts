import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

/**
 * Guards internal endpoints by comparing the `X-Internal-Api-Key` request header
 * against the `INTERNAL_API_KEY` environment variable.
 *
 * This provides lightweight authentication for service-to-service calls that
 * run within the Docker Compose network. It is not a substitute for full JWT
 * auth on user-facing endpoints — see ADR-011.
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
    if (!provided || provided !== this.expectedKey) {
      throw new UnauthorizedException('Missing or invalid internal API key');
    }
    return true;
  }
}
