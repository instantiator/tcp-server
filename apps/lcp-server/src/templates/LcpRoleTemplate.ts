import { LcpRole } from '@lcp/shared';

/** Fields required to create a new {@link LcpRole}. `queryIndex` is server-managed and excluded. */
export type LcpRoleTemplate = Omit<LcpRole, 'id' | 'company' | 'queryIndex'>;
