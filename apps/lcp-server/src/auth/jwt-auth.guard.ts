import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/** Guard that enforces JWT authentication on decorated routes using the {@link JwtStrategy}. */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
