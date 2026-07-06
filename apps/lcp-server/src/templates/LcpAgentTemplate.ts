import { LcpAgent } from '@lcp/shared';

/** Fields required to create a new {@link LcpAgent}. */
export type LcpAgentTemplate = Pick<
  LcpAgent,
  'companyId' | 'roleId' | 'initialPrompt'
> &
  Partial<Pick<LcpAgent, 'requiredToolCalls'>>;
