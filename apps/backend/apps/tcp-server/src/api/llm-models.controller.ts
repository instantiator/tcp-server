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
import { CompanyScope } from '../auth/company-scope.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ListLlmModelsDto, LlmModelsResponseDto } from './dto/llm-models.dto';
import { LlmModelsService } from './llm-models.service';

/** Lists the models a company's local model server offers, for the web picker. */
@ApiTags('companies')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyMembershipGuard)
@Controller({ path: 'api/company' })
export class LlmModelsController {
  constructor(private readonly models: LlmModelsService) {}

  /**
   * A POST, not a GET, so a typed key travels in the body rather than a URL
   * that proxies and logs keep.
   */
  @ApiOperation({ summary: 'List the models a local or custom server offers' })
  @ApiOkResponse({ type: LlmModelsResponseDto })
  @CompanyScope({ from: 'param', key: 'companyId', via: 'company' })
  @HttpCode(HttpStatus.OK)
  @Post(':companyId/llm/models')
  async list(
    @Param('companyId') companyId: string,
    @Body() body: ListLlmModelsDto,
  ): Promise<LlmModelsResponseDto> {
    return { models: await this.models.list(companyId, body) };
  }
}
