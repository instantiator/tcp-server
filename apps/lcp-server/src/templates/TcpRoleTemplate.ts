import { TcpRole } from '@tcp/shared';

/** Fields required to create a new {@link TcpRole}. `queryIndex` is server-managed and excluded. */
export type TcpRoleTemplate = Omit<TcpRole, 'id' | 'company' | 'queryIndex'>;
