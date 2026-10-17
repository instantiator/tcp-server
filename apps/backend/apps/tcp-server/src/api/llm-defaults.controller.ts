import { Controller, Get, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  DEFAULT_EMBEDDING_DIMENSION,
  resolveEnvEmbeddingConfig,
  resolveEnvLlmConfig,
} from '@tcp/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CompanyMembershipGuard } from '../auth/company-membership.guard';
import { NoCompanyScope } from '../auth/company-scope.decorator';
import { LlmDefaultsDto } from './dto/llm-defaults.dto';

/**
 * Publishes which models the application falls back to, so the web picker can
 * label "use the default". Keys and addresses are deliberately left out.
 */
@ApiTags('system')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyMembershipGuard)
@Controller({ path: 'api/system/llm-defaults' })
export class LlmDefaultsController {
  constructor(private readonly config: ConfigService) {}

  /** Returns the env-configured chat and embedding defaults, secrets omitted. */
  @ApiOperation({ summary: "Get the application's default models" })
  @ApiOkResponse({ type: LlmDefaultsDto })
  @NoCompanyScope('the same application defaults for every company')
  @Get()
  get(): LlmDefaultsDto {
    const chat = resolveEnvLlmConfig(this.config);
    const embedding = resolveEnvEmbeddingConfig(this.config);
    return {
      chat: chat && {
        provider: chat.provider,
        model: chat.model,
        contextWindow: chat.contextWindow,
      },
      embedding: embedding && {
        provider: embedding.provider,
        model: embedding.model,
      },
      // An empty env var arrives as '', so fall back on any falsy number.
      embeddingDimension:
        Number(this.config.get('EMBEDDING_DIMENSION')) ||
        DEFAULT_EMBEDDING_DIMENSION,
    };
  }
}
