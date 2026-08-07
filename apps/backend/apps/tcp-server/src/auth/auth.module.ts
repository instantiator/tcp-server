import { CompanyUser, Conversation, TcpAssignment, TcpTask } from '@tcp/shared';
import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DbModule } from '../db/db.module';
import { CompanyMembershipGuard } from './company-membership.guard';
import { CompanyResolutionService } from './company-resolution.service';
import { JwtStrategy } from './jwt.strategy';
import { MembershipService } from './membership.service';

/**
 * Wires Passport with the JWT strategy so that {@link JwtAuthGuard} can be
 * applied to any route that requires authentication, and provides the
 * {@link CompanyMembershipGuard} applied alongside it on every user-facing
 * controller.
 */
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    DbModule,
    TypeOrmModule.forFeature([
      CompanyUser,
      TcpTask,
      TcpAssignment,
      Conversation,
    ]),
  ],
  providers: [
    JwtStrategy,
    MembershipService,
    CompanyResolutionService,
    CompanyMembershipGuard,
  ],
  exports: [
    PassportModule,
    MembershipService,
    CompanyResolutionService,
    CompanyMembershipGuard,
  ],
})
export class AuthModule {}
