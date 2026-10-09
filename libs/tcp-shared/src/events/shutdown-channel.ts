/**
 * The Redis pub/sub contract between tcp-server (which owns draining) and
 * tcp-agent (which owns the running agent loops).
 *
 * Redis rather than HTTP because it is the one transport both processes
 * already share — dispatch is one-way over BullMQ, and nothing calls into
 * tcp-agent today, so an HTTP path would need new service-to-service URL
 * configuration for every deployment shape.
 */

/** Channel carrying {@link ShutdownCommand}s from tcp-server to the workers. */
export const SHUTDOWN_COMMAND_CHANNEL = 'tcp:shutdown:command';

/** Channel carrying {@link ShutdownStatusReport}s back from the workers. */
export const SHUTDOWN_STATUS_CHANNEL = 'tcp:shutdown:status';

/** What a worker should do about the drain tcp-server has started. */
export type ShutdownAction =
  /** Stop taking new jobs; let in-flight runs reach their next boundary. */
  | 'drain'
  /** Stop taking new jobs and abort in-flight LLM calls immediately. */
  | 'force'
  /** The drain was cancelled — go back to taking jobs. */
  | 'cancel'
  /** A restart drain has quiesced: exit, so the supervisor starts a fresh process. */
  | 'restart';

/** A drain instruction broadcast to every tcp-agent worker. */
export interface ShutdownCommand {
  action: ShutdownAction;
}

/**
 * A worker's report of how much work it still has in flight, which is what
 * lets tcp-server tell "the drain has been requested" apart from "every agent
 * has actually stopped".
 *
 * ponytail: assumes one tcp-agent instance, as a multi-host deployment is out
 * of scope — several workers' reports would overwrite each other. Key the
 * server's tally by a worker id if that changes.
 */
export interface ShutdownStatusReport {
  /** Agent loops the worker is still running. Zero means it has come to rest. */
  activeAgents: number;
}
