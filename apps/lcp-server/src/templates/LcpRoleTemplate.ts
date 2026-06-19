import { LcpRole } from '@lcp/shared';

/** Fields required to create a new {@link LcpRole}. */
export type LcpRoleTemplate = Omit<LcpRole, 'id' | 'company'>;
