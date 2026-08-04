import type { UUID } from '../uuid';
import type {
  TcpAssignment,
  TcpAssignmentMode,
  TcpAssignmentStatus,
} from '../models/TcpAssignment.model';
import type { TcpTask, TcpTaskStatus } from '../models/TcpTask.model';
import type { AuditEventType } from '../models/AuditEvent.model';
import type { AgentStatus, TcpAgent } from '../models/TcpAgent.model';
import type {
  Conversation,
  ConversationStatus,
} from '../models/Conversation.model';

/**
 * A serialized {@link AuditEvent} row as it crosses the SSE/Redis wire.
 *
 * Audit events are the single source of truth for both history and live
 * streaming (`docs/prompts/010.5.1`): the same row that is persisted is
 * published live, so history replay and the live stream share one render path.
 * `id` is absent for synthesized replay/prime events (nothing persisted).
 */
export interface AuditWireEvent {
  /** Persisted row id; absent for synthesized replay/prime events. */
  id?: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  companyId: string;
  role: string;
  agentId: string | null;
  assignmentId: string | null;
  taskId: string | null;
  eventType: AuditEventType;
  payload: Record<string, unknown>;
}

/**
 * A live-only fragment of a model turn's output. Token deltas arrive in the
 * hundreds–thousands per turn, so they are streamed but never persisted per
 * chunk; the turn's full text lands in the `llm_response` audit row, and the
 * concatenation of a turn's deltas equals that row's `responseText` (both are
 * computed by tcp-agent from the same LangGraph stream).
 */
export interface StreamDelta {
  type: 'stream';
  agentId: string;
  channel: 'reasoning' | 'response';
  delta: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
}

/** Everything crossing an SSE/Redis event stream: a persisted audit row or a live delta. */
export type WireEvent = { type: 'audit'; event: AuditWireEvent } | StreamDelta;

// Redis channel names, one per scoped SSE stream.

/** Redis pub/sub channel carrying {@link WireEvent}s for one agent. */
export const agentEventsChannel = (agentId: string): string =>
  `agent:events:${agentId}`;

/** Redis pub/sub channel carrying {@link WireEvent}s for one task. */
export const taskEventsChannel = (taskId: string): string =>
  `task:events:${taskId}`;

/** Redis pub/sub channel carrying {@link WireEvent}s for one company. */
export const companyEventsChannel = (companyId: string): string =>
  `company:events:${companyId}`;

// Payload summary types carried inside state_change payloads.

/**
 * Minimal task summary carried in a task/company `state_change` payload (and
 * the task list fetch) — enough for a task-list row to render/update without a
 * refetch. `completedSteps`/`totalSteps` count the task's implement-mode plan
 * assignments (`succeeded` / all).
 */
export interface TaskChangeSummary {
  id: UUID;
  status: TcpTaskStatus;
  request: string;
  shortcode: string;
  createdAt: string;
  updatedAt: string;
  completedSteps: number;
  totalSteps: number;
}

/** Builds a {@link TaskChangeSummary} from a task and its implement-mode plan assignments. */
export function buildTaskChangeSummary(
  task: Pick<
    TcpTask,
    'id' | 'status' | 'request' | 'shortcode' | 'createdAt' | 'updatedAt'
  >,
  planAssignments: Pick<TcpAssignment, 'status'>[],
): TaskChangeSummary {
  return {
    id: task.id,
    status: task.status,
    request: task.request,
    shortcode: task.shortcode,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    completedSteps: planAssignments.filter((a) => a.status === 'succeeded')
      .length,
    totalSteps: planAssignments.length,
  };
}

/** Minimal assignment summary carried in an assignment `state_change` payload. */
export interface AssignmentChangeSummary {
  id: UUID;
  status: TcpAssignmentStatus;
  mode: TcpAssignmentMode;
  orderIndex: number | null;
  /** The role working the assignment — what lets a row render a role name. */
  roleId: UUID | null;
}

/** Builds an {@link AssignmentChangeSummary} from an assignment. */
export function buildAssignmentChangeSummary(
  assignment: Pick<
    TcpAssignment,
    'id' | 'status' | 'mode' | 'orderIndex' | 'roleId'
  >,
): AssignmentChangeSummary {
  return {
    id: assignment.id,
    status: assignment.status,
    mode: assignment.mode,
    orderIndex: assignment.orderIndex ?? null,
    roleId: assignment.roleId ?? null,
  };
}

/** Minimal agent summary carried in an agent `state_change` payload. */
export interface AgentChangeSummary {
  id: UUID;
  status: AgentStatus;
  roleId: UUID | null;
  assignmentId: UUID | null;
}

/** Builds an {@link AgentChangeSummary} from an agent. */
export function buildAgentChangeSummary(
  agent: Pick<TcpAgent, 'id' | 'status' | 'roleId' | 'assignmentId'>,
): AgentChangeSummary {
  return {
    id: agent.id,
    status: agent.status,
    roleId: agent.roleId ?? null,
    assignmentId: agent.assignmentId ?? null,
  };
}

/**
 * Minimal enquiry (conversation) summary carried in an enquiry `state_change`
 * payload. An enquiry has no entity of its own — it is a {@link Conversation}
 * — so this is the only shape the company stream carries for one.
 */
export interface EnquiryChangeSummary {
  id: UUID;
  slug: string;
  status: ConversationStatus;
  roleName: string;
  question: string;
  createdAt: string;
}

/** Builds an {@link EnquiryChangeSummary} from a conversation. */
export function buildEnquiryChangeSummary(
  conv: Pick<
    Conversation,
    'id' | 'slug' | 'status' | 'roleName' | 'question' | 'createdAt'
  >,
): EnquiryChangeSummary {
  return {
    id: conv.id,
    slug: conv.slug,
    status: conv.status,
    roleName: conv.roleName,
    question: conv.question,
    createdAt: conv.createdAt.toISOString(),
  };
}
