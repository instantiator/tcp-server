import { InternalApiKeyGuard, RecordsService } from '@tcp/shared';
import {
  Controller,
  Delete,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { ApiSecurity, ApiTags } from '@nestjs/swagger';

/**
 * Service-to-service routes. tcp-server calls `DELETE` after deleting a
 * company, so a records database of its own — where no foreign key can
 * cascade from `tcp_company` — drops that company's tables too. In a shared
 * database the cascade has already done it, and the call deletes nothing.
 */
@ApiTags('internal')
@ApiSecurity('internal-api-key')
@UseGuards(InternalApiKeyGuard)
@Controller('internal/companies')
export class RecordsInternalController {
  constructor(private readonly records: RecordsService) {}

  /** Deletes every record table of the company; returns how many went. */
  @Delete(':companyId/records')
  async deleteCompanyRecords(
    @Param('companyId', ParseUUIDPipe) companyId: string,
  ): Promise<{ tables: number }> {
    return { tables: await this.records.deleteCompany(companyId) };
  }
}
