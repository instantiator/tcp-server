// The tcp-server REST calls a chat session makes, as plain functions over a
// TokenManager. Keeping them together means the session class reads as
// orchestration rather than a list of URLs.

import { TokenManager } from '../auth/token';

/** A chat agent as `POST /api/agent/chat/start` returns it. */
export interface AgentRecord {
  id: string;
  status: string;
  assignmentId: string;
}

/** Creates a new chat-mode agent for `roleId`. */
export async function startChatAgent(
  tokens: TokenManager,
  companyId: string,
  roleId: string,
): Promise<AgentRecord> {
  return tokens.request<AgentRecord>('POST', '/api/agent/chat/start', {
    companyId,
    roleId,
  });
}

/** Deletes one agent. */
export async function deleteAgent(
  tokens: TokenManager,
  agentId: string,
): Promise<void> {
  await tokens.request('DELETE', `/api/agent/${agentId}`);
}
