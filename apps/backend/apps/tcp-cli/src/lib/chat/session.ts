import { GlobalOptions } from '../core/cli-options';
import { TokenManager, TokenSession } from '../auth/token';
import * as api from './session-api';
import { TurnRunner } from './turn-runner';

/**
 * Owns one chat session's mutable state — its {@link TokenManager} and every
 * agent created (for cleanup) — and the operations that act on it: starting an
 * agent, running turns, and cleanup.
 *
 * Turns themselves are run by {@link TurnRunner}; the REST calls live in
 * {@link api}.
 *
 * NB. kept as a class because every operation shares this same mutable state;
 * the class just gives that state a name instead of a chain of captured
 * variables.
 */
export class ChatSession {
  private readonly agentIds = new Set<string>();
  /** Owns the session's access token, refreshing it in the background so a
   * long-running chat session doesn't hit a stale-token 401. */
  private readonly tokenManager: TokenManager;
  private readonly turns: TurnRunner;

  constructor(
    private readonly opts: GlobalOptions,
    readonly companyId: string,
    hideReasoning: boolean,
    tokens: TokenSession,
  ) {
    this.tokenManager = new TokenManager(this.opts.tcpServer, tokens);
    this.turns = new TurnRunner(
      this.tokenManager,
      this.opts.tcpServer,
      hideReasoning,
    );
  }

  /** Whether any agent has a turn in flight. */
  get hasInFlightTurns(): boolean {
    return this.turns.hasInFlightTurns;
  }

  /** Aborts every in-flight turn (the agents continue running server-side). */
  abortAllTurns(): void {
    this.turns.abortAll();
  }

  /** Runs one turn on `agentId`'s agent — see {@link TurnRunner.runTurn}. */
  async runTurn(
    agentId: string,
    message: string,
    interactive: boolean,
  ): Promise<void> {
    await this.turns.runTurn(agentId, message, interactive);
  }

  /**
   * Creates a new chat-mode agent for `roleId` and returns its id; the agent is
   * deleted on {@link cleanup}.
   */
  async startAgent(roleId: string): Promise<string> {
    const agent = await api.startChatAgent(
      this.tokenManager,
      this.companyId,
      roleId,
    );
    this.agentIds.add(agent.id);
    return agent.id;
  }

  /** Deletes every agent created this session (best-effort) and stops the token refresher. */
  async cleanup(): Promise<void> {
    for (const id of this.agentIds) {
      await this.deleteAgent(id);
    }
    this.agentIds.clear();
    this.tokenManager.stop();
  }

  /** DELETEs one agent (best-effort — failures are logged, not thrown). */
  private async deleteAgent(id: string): Promise<void> {
    try {
      await api.deleteAgent(this.tokenManager, id);
      process.stderr.write(`\nAgent ${id} removed.\n`);
    } catch {
      // best-effort cleanup
    }
  }
}
