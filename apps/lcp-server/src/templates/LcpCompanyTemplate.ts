import { LcpCompany } from '@lcp/shared';

/** `nextTaskShortcodeIndex` is server-managed and excluded — see `LcpCompany.nextTaskShortcodeIndex`. */
export type LcpCompanyTemplate = Omit<
  LcpCompany,
  'id' | 'slug' | 'nextTaskShortcodeIndex'
>;
