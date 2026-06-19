import { LcpCompany } from '@lcp/shared';

export type LcpCompanyTemplate = Omit<LcpCompany, 'id' | 'slug'>;
