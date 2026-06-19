import { Injectable } from '@nestjs/common';

/** Handle for a running agent loop, allowing it to be cancelled. */
interface AgentHandle {
  abortController: AbortController;
}

/**
 * In-memory registry of currently running agent loops.
 * Allows the worker to check whether an agent is already active before
 * dispatching a duplicate job, and provides a handle for cancellation.
 */
@Injectable()
export class AgentRegistryService {
  private readonly running = new Map<string, AgentHandle>();

  /** Registers an agent as active. Replaces any existing entry with the same id. */
  register(agentId: string, abortController: AbortController): void {
    this.running.set(agentId, { abortController });
  }

  /** Removes the agent from the registry (call in the finally block after the loop ends). */
  deregister(agentId: string): void {
    this.running.delete(agentId);
  }

  /** Returns `true` if the agent currently has an active loop. */
  isRunning(agentId: string): boolean {
    return this.running.has(agentId);
  }

  /** Returns the number of currently active agent loops. */
  get activeCount(): number {
    return this.running.size;
  }
}
