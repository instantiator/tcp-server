import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  ValidationPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { TcpCompany } from '@tcp/shared';
import { CompanyMembershipGuard } from '../../auth/company-membership.guard';
import {
  CompanyScope,
  NoCompanyScope,
} from '../../auth/company-scope.decorator';
import {
  getCurrentUserCreatorName,
  getCurrentUserId,
  getCurrentUserIdentifiers,
} from '../../auth/current-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { MembershipService } from '../../auth/membership.service';
import { assertSlugClaimable } from '../../api/company-slug';
import {
  CompanyTemplatePreviewDto,
  ImportCompanyOptionsDto,
} from '../../api/dto/company-template.dto';
import { CompanyResponseDto } from '../../api/dto/entity-response.dto';
import { MAX_UPLOAD_BYTES } from '../../api/upload-limit';
import {
  computeCompanyWarnings,
  setWarningsHeader,
} from '../../api/validation-warnings';
import { DbService } from '../../db/db.service';
import { CompanyTemplateService } from './company-template.service';
import { ParsedTemplate, parseTemplate } from './format';
import { TemplateSourceService } from './template-source.service';

/** Subset of the multer file object a template upload needs. */
interface UploadedTemplate {
  buffer: Buffer;
}

const UPLOAD_OPTIONS = { limits: { fileSize: MAX_UPLOAD_BYTES } };

const TEMPLATE_FILE = {
  type: 'string',
  format: 'binary',
  description: 'The template as a zip.',
} as const;

const TEMPLATE_ID = {
  type: 'string',
  description: 'A gallery template, as <sourceId>/<name>, instead of a file.',
} as const;

const optionsPipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

/**
 * Company templates in and out: preview a template, import it as a new
 * company, and export a company as a template.
 */
@ApiTags('companies')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyMembershipGuard)
@Controller({ path: 'api/company' })
export class CompanyTemplateController {
  constructor(
    private readonly templates: CompanyTemplateService,
    private readonly db: DbService,
    private readonly membership: MembershipService,
    private readonly sources: TemplateSourceService,
  ) {}

  /** The template sent as `file`, or the gallery template named by `template`. */
  private async resolve(
    file: UploadedTemplate | undefined,
    template: string | undefined,
  ): Promise<ParsedTemplate> {
    if (file && template) {
      throw new BadRequestException(
        'Send either `file` or `template`, not both.',
      );
    }
    if (template) {
      const [sourceId, ...name] = template.split('/');
      return parseTemplate(
        await this.sources.templateFiles(sourceId, name.join('/')),
      );
    }
    return this.templates.read(requireZip(file));
  }

  /** Reads a template and says what importing it would create. */
  @ApiOperation({ summary: 'Preview a company template before importing it' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: TEMPLATE_FILE, template: TEMPLATE_ID },
    },
  })
  @ApiOkResponse({ type: CompanyTemplatePreviewDto })
  @NoCompanyScope('reads an uploaded template and creates nothing')
  @Post('import/preview')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', UPLOAD_OPTIONS))
  async preview(
    @UploadedFile() file: UploadedTemplate | undefined,
    @Body('template') template: string | undefined,
  ): Promise<CompanyTemplatePreviewDto> {
    return this.templates.preview(await this.resolve(file, template));
  }

  /**
   * Creates a company from a template, with the importer's choices from
   * `options` applied. A taken slug is a 409 unless `options.replace` is set,
   * under the same rule as creating a company. Anything the importer should
   * know, such as an API key the template held, travels in `X-Tcp-Warnings`.
   */
  @ApiOperation({ summary: 'Create a company from a template' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: TEMPLATE_FILE,
        template: TEMPLATE_ID,
        options: {
          type: 'string',
          description:
            'ImportCompanyOptions as a JSON string: slug, name, description, ' +
            'timezone, companyContext, llmConfig, embeddingConfig, ' +
            'roleModels and replace. Absent fields keep the template’s values.',
        },
      },
    },
  })
  @ApiCreatedResponse({ type: CompanyResponseDto })
  @NoCompanyScope(
    'any authenticated caller may create a company; replacing one needs membership of it, checked in the handler',
  )
  @Post('import')
  @UseInterceptors(FileInterceptor('file', UPLOAD_OPTIONS))
  async import(
    @UploadedFile() file: UploadedTemplate | undefined,
    @Body('template') template: string | undefined,
    @Body('options') rawOptions: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TcpCompany> {
    const options = await parseOptions(rawOptions);
    const parsed = await this.resolve(file, template);
    await assertSlugClaimable(
      this.db,
      this.membership,
      options.slug ?? parsed.template.slug,
      options.replace === true,
      getCurrentUserIdentifiers(req),
    );
    const user = getCurrentUserId(req);
    const company = await this.templates.import(parsed, options, {
      identifier: user ?? 'unknown',
      name: getCurrentUserCreatorName(req),
      originators: { user, agent: null, task: null },
    });
    setWarningsHeader(res, [
      ...parsed.warnings,
      ...computeCompanyWarnings(company),
    ]);
    return company;
  }

  /**
   * Downloads a company as a template zip. API keys are never included;
   * `?models=false` leaves out every model too.
   */
  @ApiOperation({ summary: 'Export a company as a template' })
  @ApiQuery({
    name: 'models',
    required: false,
    type: Boolean,
    description:
      'Include the company’s and roles’ models (never their keys). Defaults to true.',
  })
  @ApiProduces('application/zip')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  @CompanyScope({ from: 'param', key: 'companyId', via: 'company' })
  @Get(':companyId/export')
  async export(
    @Param('companyId') companyId: string,
    @Res() res: Response,
    @Query('models') models?: string,
  ): Promise<void> {
    const company = await this.db.getCompany(companyId);
    if (!company) throw new NotFoundException(`Company ${companyId} not found`);
    const download = await this.templates.export(company, models !== 'false');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${download.filename}"`,
    );
    res.send(Buffer.from(download.body));
  }
}

/** The uploaded zip's bytes, or a 400 when neither a file nor a template was sent. */
function requireZip(file: UploadedTemplate | undefined): Uint8Array {
  if (!file)
    throw new BadRequestException(
      'Send the template as `file`, or name a gallery `template`.',
    );
  return new Uint8Array(file.buffer);
}

/** Parses and validates the `options` form field. */
async function parseOptions(
  raw: string | undefined,
): Promise<ImportCompanyOptionsDto> {
  let value: unknown = {};
  if (raw !== undefined && raw !== '') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new BadRequestException('options must be a JSON object.');
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BadRequestException('options must be a JSON object.');
  }
  return (await optionsPipe.transform(value, {
    type: 'body',
    metatype: ImportCompanyOptionsDto,
  })) as ImportCompanyOptionsDto;
}
