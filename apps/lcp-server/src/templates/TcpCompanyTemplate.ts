import { TcpCompany } from '@lcp/shared';

/** `nextTaskShortcodeIndex` is server-managed and excluded — see `TcpCompany.nextTaskShortcodeIndex`. */
export type TcpCompanyTemplate = Omit<
  TcpCompany,
  'id' | 'slug' | 'nextTaskShortcodeIndex'
>;
