import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LcpCompany } from '@lcp/shared';
import { LcpCompanyTemplate } from '../templates/LcpCompanyTemplate';
import { defined, isUUID } from '../utils/ObjectUtils';

@Injectable()
export class DbService {
  constructor(
    @InjectRepository(LcpCompany)
    private readonly repo: Repository<LcpCompany>,
  ) {}

  /**
   * Creates a new {@link LcpCompany} from template,
   * replacing any existing record with the same slug.
   */
  async createCompany(
    template: LcpCompanyTemplate,
    slug: string,
  ): Promise<LcpCompany> {
    await this.repo.delete({ slug });

    const company: LcpCompany = {
      ...template,
      id: undefined!,
      slug,
    };

    return await this.repo.save(company);
  }

  /**
   * Either creates or updates an {@link LcpCompany}.
   *
   * @param LcpCompany the company to create or update
   * @param replace if `true`, removes any old {@link LcpCompany} in the
   *   db matching the id or slug of the company provided
   */
  async setCompany(
    company: Partial<LcpCompany>,
    replace: boolean,
  ): Promise<LcpCompany> {
    if (replace) {
      await this.repo.delete({ slug: company.slug });
    }

    // don't overwrite existing companies with this id (skip lookup when id is absent)
    const existingCompany = company.id
      ? await this.repo.findOneBy({ id: company.id })
      : null;

    if (!defined(existingCompany)) {
      // simple case: store the new company record
      return await this.repo.save(this.repo.create(company));
    } else {
      // merge the new company into the existing
      const updatedCompany: LcpCompany = {
        ...existingCompany,
        ...company,
      };
      return await this.repo.save(this.repo.create(updatedCompany));
    }
  }

  /** Retrieves a company by its id or slug */
  async getCompany(identifier: string): Promise<LcpCompany | null> {
    return isUUID(identifier)
      ? await this.repo.findOneBy({ id: identifier })
      : await this.repo.findOneBy({ slug: identifier });
  }
}
