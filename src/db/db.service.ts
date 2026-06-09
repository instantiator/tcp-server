import { Injectable, OnModuleInit } from '@nestjs/common';
import { Sequelize } from 'sequelize';
import '../models';
import { TcpCompany } from '../models';
import { defined, isUUID } from '../utils/ObjectUtils';
import { getRegisteredModels } from './model-registry';

@Injectable()
export class DbService implements OnModuleInit {
  sequelize!: Sequelize;

  /**
   * Initialises the database connection.
   * By default, uses an sqlite in memory - but will be configurable in future.
   **/
  async onModuleInit() {
    this.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:' });
    await this.sequelize.authenticate();
    for (const Model of getRegisteredModels()) {
      Model.register(this.sequelize);
    }
    await this.sequelize.sync({ alter: true });
  }

  /** Either creates or updates a company, using the provided data */
  async setCompany(company: Partial<TcpCompany>, replace: boolean) {
    console.debug('Setting company...', { company, replace });

    if (replace) {
      const removed = await TcpCompany.destroy({
        where: { slug: company.slug },
        cascade: true,
      });
      console.debug(
        `Removed ${removed} previous instances of: ${company.slug}`,
      );
    }

    const existing = await TcpCompany.findByPk(company.id ?? undefined);
    if (defined(existing)) {
      console.debug(`Updating ${company.slug} instance...`);
      await existing.update(company);
    } else {
      console.debug(`Creating ${company.slug} instance...`);
      const newCompany = TcpCompany.build(company);
      await newCompany.save();
    }
  }

  /** Retrieves a company by its id or slug */
  async getCompany(identifier: string): Promise<TcpCompany | null> {
    return isUUID(identifier)
      ? await TcpCompany.findByPk(identifier)
      : await TcpCompany.findOne({ where: { slug: identifier } });
  }
}
