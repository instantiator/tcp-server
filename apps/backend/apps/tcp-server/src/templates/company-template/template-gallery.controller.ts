import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CompanyMembershipGuard } from '../../auth/company-membership.guard';
import { AdminOnly, NoCompanyScope } from '../../auth/company-scope.decorator';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import {
  AddTemplateSourceDto,
  GalleryTemplateDto,
  TemplateSourceDto,
} from '../../api/dto/company-template.dto';
import { setWarningsHeader } from '../../api/validation-warnings';
import {
  GalleryTemplate,
  TemplateSourceService,
  TemplateSourceView,
} from './template-source.service';
import { writeZip } from './zip';

/** The template gallery and the sources it reads from. */
@ApiTags('templates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyMembershipGuard)
@Controller({ path: 'api' })
export class TemplateGalleryController {
  constructor(private readonly sources: TemplateSourceService) {}

  /**
   * Every template from every source. A source that can't be read is named
   * in `X-Tcp-Warnings` rather than failing the list.
   */
  @ApiOperation({ summary: 'List the templates in the gallery' })
  @ApiOkResponse({ type: GalleryTemplateDto, isArray: true })
  @NoCompanyScope('the gallery belongs to no company')
  @Get('template')
  async gallery(
    @Res({ passthrough: true }) res: Response,
  ): Promise<GalleryTemplate[]> {
    const { templates, warnings } = await this.sources.gallery();
    setWarningsHeader(res, warnings);
    return templates;
  }

  /** Downloads one gallery template as a zip. */
  @ApiOperation({ summary: 'Download a gallery template as a zip' })
  @ApiProduces('application/zip')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  @NoCompanyScope('the gallery belongs to no company')
  @Get('template/:sourceId/:name')
  async download(
    @Param('sourceId') sourceId: string,
    @Param('name') name: string,
    @Res() res: Response,
  ): Promise<void> {
    const files = await this.sources.templateFiles(sourceId, name);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.zip"`);
    res.send(Buffer.from(writeZip(files)));
  }

  /** Every source, the built-in one first. */
  @ApiOperation({ summary: 'List the template gallery’s sources' })
  @ApiOkResponse({ type: TemplateSourceDto, isArray: true })
  @NoCompanyScope('the gallery belongs to no company')
  @Get('template-source')
  listSources(): Promise<TemplateSourceView[]> {
    return this.sources.list();
  }

  /** Adds a public GitHub repository as a source. */
  @ApiOperation({ summary: 'Add a GitHub repository as a template source' })
  @ApiCreatedResponse({ type: TemplateSourceDto })
  @AdminOnly()
  @Post('template-source')
  addSource(@Body() body: AddTemplateSourceDto): Promise<TemplateSourceView> {
    return this.sources.addGithub(body.name, body.repo, body.ref, body.path);
  }

  /** Removes a source an administrator added. */
  @ApiOperation({ summary: 'Remove a template source' })
  @AdminOnly()
  @Delete('template-source/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeSource(@Param('id') id: string): Promise<void> {
    return this.sources.remove(id);
  }
}
