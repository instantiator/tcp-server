import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  ModelCompatibilityResult,
  ModelCompatibilityService,
} from '../model-check/model-compatibility.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CompanyMembershipGuard } from '../auth/company-membership.guard';
import { AdminOnly } from '../auth/company-scope.decorator';
import {
  ModelCheckDto,
  ModelCompatibilityResultDto,
} from './dto/model-check.dto';

/** REST controller for checking LLM model compatibility with the agent loop. */
@ApiTags('model')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyMembershipGuard)
@Controller({ path: 'api/model' })
export class ModelController {
  constructor(private readonly checker: ModelCompatibilityService) {}

  /**
   * Probes each model in the request body and returns a compatibility report.
   *
   * Each probe makes a live network call to the configured provider to test
   * tool-calling and structured-output support. A destination outside the
   * provider catalogue or `LLM_ALLOWED_HOSTS` is refused without a call.
   *
   * @example
   * POST /api/model/check
   * { "models": [{ "provider": "lm-studio", "model": "qwen3-5b", "baseUrl": "http://host.docker.internal:1234/v1" }] }
   */
  @ApiOperation({ summary: 'Check LLM model compatibility' })
  // Administrators only: the server connects to the address in the body, so
  // this is a network probe. LlmDestinationPolicy limits where it may connect.
  @AdminOnly()
  @Post('check')
  @ApiCreatedResponse({ type: ModelCompatibilityResultDto, isArray: true })
  async checkCompatibility(
    @Body() body: ModelCheckDto,
  ): Promise<ModelCompatibilityResult[]> {
    return this.checker.check(body.models ?? []);
  }
}
