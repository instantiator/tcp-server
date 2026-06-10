import { LcpCompany } from '../models';

export type LcpCompanyTemplate = Omit<LcpCompany, 'id' | 'slug'>;
