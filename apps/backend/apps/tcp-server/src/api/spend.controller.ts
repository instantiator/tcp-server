import { SpendCapState } from '@tcp/shared';
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CompanyMembershipGuard } from '../auth/company-membership.guard';
import { AdminOnly } from '../auth/company-scope.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SpendCapService } from '../spend/spend-cap.service';
import { DismissCapDto } from './dto/spend.dto';
import { SpendResumeService } from './spend-resume.service';

/**
 * Application-level spend caps (`SPEND_CAPS`). Lifting or restoring a cap
 * changes spend protection for every company, so both are administrator-only.
 */
@ApiTags('spend')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyMembershipGuard)
@Controller({ path: 'api/spend' })
export class SpendController {
  constructor(
    private readonly caps: SpendCapService,
    private readonly resume: SpendResumeService,
  ) {}

  /**
   * Lifts a provider's cap — until it next resets, or indefinitely — and
   * resumes the agents caps paused.
   */
  @ApiOperation({ summary: "Lift a provider's spend cap" })
  @ApiOkResponse({ type: SpendCapState })
  @AdminOnly()
  @Post('caps/:provider/dismiss')
  @HttpCode(HttpStatus.OK)
  dismiss(
    @Param('provider') provider: string,
    @Body() body: DismissCapDto,
  ): Promise<SpendCapState> {
    return this.resume.dismissCap(
      provider,
      body.until === 'reset' ? 'until-reset' : 'indefinite',
    );
  }

  /** Puts a lifted cap back into force, re-evaluating it straight away. */
  @ApiOperation({ summary: "Restore a provider's spend cap" })
  @ApiOkResponse({ type: SpendCapState })
  @AdminOnly()
  @Post('caps/:provider/restore')
  @HttpCode(HttpStatus.OK)
  restore(@Param('provider') provider: string): Promise<SpendCapState> {
    return this.caps.restore(provider);
  }
}
