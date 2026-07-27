import { LlmConfig } from '@tcp/shared';
import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ModelCompatibilityResult,
  ModelCompatibilityService,
} from '../model-check/model-compatibility.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

/** REST controller for checking LLM model compatibility with the agent loop. */
@ApiTags('model')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'api/model' })
export class ModelController {
  constructor(private readonly checker: ModelCompatibilityService) {}

  /**
   * Probes each model in the request body and returns a compatibility report.
   *
   * Each probe makes a live network call to the configured provider to test
   * tool-calling and structured-output support.
   *
   * @example
   * POST /api/model/check
   * { "models": [{ "provider": "lm-studio", "model": "qwen3-5b", "baseUrl": "http://localhost:1234/v1" }] }
   */
  @ApiOperation({ summary: 'Check LLM model compatibility' })
  @Post('check')
  async checkCompatibility(
    @Body() body: { models: LlmConfig[] },
  ): Promise<ModelCompatibilityResult[]> {
    return this.checker.check(body.models ?? []);
  }
}
