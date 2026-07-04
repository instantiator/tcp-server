import { Command } from 'commander';
import * as readline from 'readline';
import { apiRequest } from '../lib/api';
import { renewToken, resolveSession } from '../lib/auth';
import { createRenderer, Renderer } from '../lib/render';
import { parseSseBuffer, SseEvent } from '../lib/sse';
import { Tui, tuiRenderer } from '../lib/tui';

interface AgentRecord {
  id: string;
}

/** Result of watching one agent's turn to its terminal event. */
type TurnOutcome = { response: string } | { error: string };

/** Sentinel error signalling the SSE stream ended before a terminal event. */
const STREAM_ENDED = 'stream ended before completion';

/**
 * Whether the full-screen TUI should replace the linear stdout/stderr
 * renderer: only when stdout is a real TTY (there's a screen to draw
 * full-screen to) and the user hasn't passed `--no-tui`. This holds for
 * `--query` too — only a genuinely piped/redirected stdout falls back to the
 * plain renderer.
 */
export function shouldUseTui(
  cmdOpts: { tui?: boolean },
  isTty: boolean,
): boolean {
  return isTty && cmdOpts.tui !== false;
}

/** Reads a string field from an SSE event's data payload. */
function eventStr(event: SseEvent, key: string): string {
  const value = event.data?.[key];
  return typeof value === 'string' ? value : '';
}

/** Resolves after `ms`, or immediately if the signal aborts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Initiates a conversation with an agent running the specified role.
 *
 * Single-query mode (-q): creates the agent, sends one message, streams the
 * response to stderr while printing the final answer to stdout, then deletes
 * the agent. Interactive mode: enters a readline loop; the agent is deleted on
 * exit or Ctrl+C.
 *
 * Each turn returns `202 Accepted`; all output (agent state, LLM activity,
 * reasoning, response, and completion) arrives on the agent's SSE event stream
 * (`GET /api/agent/:id/events`). When the agent pauses to consult another
 * agent, the CLI follows the consulted agent's stream too, prefixing its lines
 * with the consulted role's name.
 *
 * Conversation history is maintained server-side in the LangGraph checkpoint
 * store (keyed by the agent's thread_id = agent.id), so context carries across
 * turns.
 *
 * Ctrl+C behaviour in interactive mode:
 * - While a turn is in flight: stops watching (the agent continues on the
 *   server) and re-shows the prompt.
 * - When idle (at the prompt): cleans up the agent and exits.
 *
 * When stdout is a real TTY (and `--no-tui` wasn't passed), a full-screen TUI
 * (see `../lib/tui.ts`) replaces the linear stdout/stderr rendering above with
 * one tab per monitored agent — the root agent plus a tab per consultation it
 * follows — each with independent scrollback, and an input box shown only for
 * the root (talkable) agent. `--query` at a TTY also uses the TUI: the query
 * is submitted automatically (no input box), and the TUI tears down as soon
 * as the root agent's turn reaches its terminal event, after which the final
 * response is printed to stdout exactly as in the piped case. When stdout is
 * not a TTY (piped), or `--no-tui` is passed, the linear renderer is used
 * unchanged — this is the only case where the TUI is skipped.
 */
export function registerChat(program: Command): void {
  program
    .command('chat')
    .description('Start an interactive chat session with an agent')
    .requiredOption('-r, --role-id <uuid>', 'Role UUID for the agent')
    .option('-q, --query <message>', 'Single query (non-interactive)')
    .option('--hide-reasoning', 'Hide the model reasoning stream')
    .option('--no-tui', 'Disable the full-screen TUI even on a TTY')
    .action(
      async (cmdOpts: {
        roleId: string;
        query?: string;
        hideReasoning?: boolean;
        tui?: boolean;
      }) => {
        const opts = program.opts<{
          lcpServer: string;
          accessToken?: string;
          refreshToken?: string;
          accessTokenEnvVar?: string;
          username?: string;
          password?: string;
        }>();

        let agentId: string | undefined;
        let roleName = '';
        const useTui = shouldUseTui(cmdOpts, Boolean(process.stdout.isTTY));

        const cleanup = async () => {
          if (agentId) {
            try {
              await apiRequest(
                { baseUrl: opts.lcpServer, token },
                'DELETE',
                `/api/agent/${agentId}`,
              );
              process.stderr.write(`\nAgent ${agentId} removed.\n`);
            } catch {
              // best-effort cleanup
            }
            agentId = undefined;
          }
        };

        let token: string;
        let refreshToken: string | undefined;
        try {
          ({ token, refreshToken } = await resolveSession({
            ...opts,
            baseUrl: opts.lcpServer,
          }));

          // We need the company ID to start a chat — resolve it from the role
          type LlmConfig = {
            provider: string;
            model: string;
            baseUrl?: string;
          };
          const role = await apiRequest<{
            id: string;
            companyId: string;
            name: string;
            llmConfig?: LlmConfig | null;
          }>(
            { baseUrl: opts.lcpServer, token },
            'GET',
            `/api/role/${cmdOpts.roleId}`,
          );

          // Mirror the agent's resolution: role.llmConfig → company.llmDefault → server env fallback
          let llmConfig = role.llmConfig;
          if (!llmConfig) {
            const company = await apiRequest<{ llmDefault?: LlmConfig | null }>(
              { baseUrl: opts.lcpServer, token },
              'GET',
              `/api/company/${role.companyId}`,
            );
            llmConfig = company.llmDefault ?? null;
          }

          const agent = await apiRequest<AgentRecord>(
            { baseUrl: opts.lcpServer, token },
            'POST',
            '/api/agent/chat/start',
            { companyId: role.companyId, roleId: cmdOpts.roleId },
          );
          agentId = agent.id;
          roleName = role.name;
          process.stderr.write(`LCP API: ${opts.lcpServer}\n`);
          if (llmConfig) {
            process.stderr.write(
              `LLM API: ${llmConfig.baseUrl ?? '(provider default)'}\n`,
            );
            process.stderr.write(`Provider: ${llmConfig.provider}\n`);
            process.stderr.write(`Model: ${llmConfig.model}\n`);
          } else {
            process.stderr.write(`LLM: (using server environment default)\n`);
          }
          process.stderr.write(`Role: ${role.name}\n`);
          if (!useTui) {
            process.stderr.write(`'exit', 'quit', or Ctrl+C to exit.\n`);
          }
        } catch (err) {
          process.stderr.write(
            `Error: ${String(err instanceof Error ? err.message : err)}\n`,
          );
          process.exit(1);
        }

        const hideReasoning = cmdOpts.hideReasoning ?? false;

        // Constructed after the banner above prints, so it's briefly visible
        // in normal scrollback before the screen switches to the TUI.
        const tui = useTui ? new Tui({ hideReasoning }) : null;
        if (tui) {
          tui.addPane({
            id: agentId,
            label: roleName,
            talkable: !cmdOpts.query,
          });
        }

        /** Abort controller for the in-flight turn; null when idle at the prompt. */
        let currentAbort: AbortController | null = null;

        /**
         * Opens the SSE stream for `id`, rendering each event until the agent's
         * terminal (`completed`/`failed`) event arrives. When the agent pauses to
         * consult another agent, spawns a follower stream for that agent, prefixed
         * with its role name. Resolves with the outcome; resolves with a
         * {@link STREAM_ENDED} error if the stream closes with no terminal event.
         */
        const streamAgent = async (
          id: string,
          renderer: Renderer,
          signal: AbortSignal,
          onConnected?: () => void,
        ): Promise<TurnOutcome> => {
          const url = `${opts.lcpServer.replace(/\/$/, '')}/api/agent/${id}/events`;
          const followerAbort = new AbortController();
          const followers: Promise<unknown>[] = [];
          let outcome: TurnOutcome | undefined;
          try {
            const res = await fetch(url, {
              headers: { Authorization: `Bearer ${token}` },
              signal,
            });
            onConnected?.();
            if (!res.ok || !res.body) {
              return { error: `events stream failed with HTTP ${res.status}` };
            }
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            while (!outcome) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const { events, rest } = parseSseBuffer(buffer);
              buffer = rest;
              for (const event of events) {
                if (event.kind === 'completed') {
                  outcome = { response: eventStr(event, 'response') };
                  break;
                }
                if (event.kind === 'failed') {
                  outcome = { error: eventStr(event, 'error') };
                  break;
                }
                if (event.kind === 'consultation_started') {
                  const consultId = eventStr(event, 'agentId');
                  const consultRoleName = eventStr(event, 'roleName');
                  renderer.render(event);
                  if (consultId) {
                    let follower: Renderer;
                    if (tui) {
                      tui.addPane({
                        id: consultId,
                        label: consultRoleName,
                        talkable: false,
                      });
                      follower = tuiRenderer(tui, consultId);
                    } else {
                      follower = createRenderer({
                        hideReasoning,
                        rolePrefix: consultRoleName,
                        out: process.stderr,
                        err: process.stderr,
                      });
                    }
                    followers.push(
                      streamAgent(
                        consultId,
                        follower,
                        followerAbort.signal,
                      ).catch(() => undefined),
                    );
                  }
                  continue;
                }
                renderer.render(event);
              }
            }
          } catch (err) {
            onConnected?.();
            if (err instanceof Error && err.name === 'AbortError') {
              return { error: STREAM_ENDED };
            }
            return {
              error: err instanceof Error ? err.message : String(err),
            };
          } finally {
            renderer.finish();
            followerAbort.abort();
            await Promise.allSettled(followers);
          }
          return outcome ?? { error: STREAM_ENDED };
        };

        /** POSTs a message (expects 202), refreshing the token once on 401. */
        const postMessage = async (
          message: string,
          signal: AbortSignal,
        ): Promise<void> => {
          const doPost = () =>
            apiRequest<{ accepted: boolean }>(
              { baseUrl: opts.lcpServer, token, signal },
              'POST',
              `/api/agent/${agentId}/message`,
              { message },
            );
          try {
            await doPost();
          } catch (err) {
            if (
              err instanceof Error &&
              err.message.includes('HTTP 401') &&
              refreshToken
            ) {
              token = await renewToken(opts.lcpServer, refreshToken);
              await doPost();
              return;
            }
            throw err;
          }
        };

        /**
         * Fallback when the SSE stream drops mid-turn: polls the agent record
         * until it reaches a terminal (or idle-after-run) state.
         */
        const pollForCompletion = async (
          id: string,
          signal: AbortSignal,
        ): Promise<TurnOutcome> => {
          const deadline = Date.now() + 35 * 60 * 1000;
          while (!signal.aborted && Date.now() < deadline) {
            await delay(2000, signal);
            if (signal.aborted) break;
            try {
              const agent = await apiRequest<{
                status: string;
                output?: string;
              }>(
                { baseUrl: opts.lcpServer, token, signal },
                'GET',
                `/api/agent/${id}`,
              );
              if (agent.status === 'completed' || agent.status === 'idle') {
                return { response: agent.output ?? '' };
              }
              if (agent.status === 'failed') {
                return { error: agent.output ?? 'agent failed' };
              }
            } catch {
              // transient error — keep polling
            }
          }
          return { error: 'timed out waiting for completion' };
        };

        /**
         * Runs one turn: opens the event stream, posts the message, waits for the
         * terminal event, then prints the final response. Interactive turns stream
         * the response to stdout live; `--query` turns stream progress to stderr
         * and print the final answer to stdout once (keeping it pipeable).
         */
        const runTurn = async (
          message: string,
          interactive: boolean,
        ): Promise<void> => {
          const abort = new AbortController();
          currentAbort = abort;
          // Typing stays possible while the turn runs, but Enter won't submit
          // until it finishes (the hint row explains why).
          tui?.setBusy(true);
          const signal = AbortSignal.any([
            abort.signal,
            AbortSignal.timeout(35 * 60 * 1000),
          ]);
          const renderer = tui
            ? tuiRenderer(tui, agentId!)
            : createRenderer({
                hideReasoning,
                out: interactive ? process.stdout : process.stderr,
                err: process.stderr,
              });
          try {
            // Open the stream before posting so early events aren't missed; the
            // server also replays the terminal event to late subscribers.
            let markConnected!: () => void;
            const connected = new Promise<void>((r) => (markConnected = r));
            const streamPromise = streamAgent(
              agentId!,
              renderer,
              signal,
              markConnected,
            );
            await connected;
            await postMessage(message, signal);

            let outcome = await streamPromise;
            if (
              'error' in outcome &&
              outcome.error === STREAM_ENDED &&
              !abort.signal.aborted
            ) {
              outcome = await pollForCompletion(agentId!, signal);
            }

            if (abort.signal.aborted) return;
            if ('response' in outcome) {
              if (!interactive) {
                // Tear the TUI down before writing the final answer — it must
                // land in normal scrollback, not the (about to vanish) alt screen.
                tui?.stop();
                process.stdout.write(outcome.response + '\n');
              } else if (!renderer.responseSeen) {
                if (tui) {
                  tui.appendEvent(agentId!, {
                    kind: 'response',
                    timestamp: new Date().toISOString(),
                    data: { delta: outcome.response },
                  });
                } else {
                  process.stdout.write(`\nResponse: ${outcome.response}\n`);
                }
              }
            } else if (outcome.error !== STREAM_ENDED) {
              if (tui) {
                tui.appendEvent(agentId!, {
                  kind: 'agent_status',
                  timestamp: new Date().toISOString(),
                  data: { status: 'failed', reason: outcome.error },
                });
              } else {
                process.stderr.write(`\n[Error] ${outcome.error}\n`);
              }
            }
          } catch (err) {
            const message = String(err instanceof Error ? err.message : err);
            if (tui) {
              tui.appendEvent(agentId!, {
                kind: 'agent_status',
                timestamp: new Date().toISOString(),
                data: { status: 'failed', reason: message },
              });
            } else {
              process.stderr.write(`\nError: ${message}\n`);
            }
          } finally {
            currentAbort = null;
            tui?.setBusy(false);
          }
        };

        if (cmdOpts.query) {
          if (!tui) process.stderr.write('Sending...\n');
          try {
            await runTurn(cmdOpts.query, false);
          } finally {
            tui?.stop();
            await cleanup();
          }
          return;
        }

        if (tui) {
          // The TUI's InlineInput replaces readline entirely; Ctrl+C is a raw
          // key event delivered via grabInput (not a SIGINT signal), so the
          // two-stage quit semantics are wired through Tui.onQuit instead of
          // process.on('SIGINT', ...).
          let resolveQuit!: () => void;
          const quit = new Promise<void>((r) => (resolveQuit = r));
          tui.onQuit(() => {
            if (currentAbort) {
              currentAbort.abort();
              currentAbort = null;
            } else {
              tui.stop();
              resolveQuit();
            }
          });
          tui.onSubmit((message) => {
            if (currentAbort) return; // ignore submits while a turn is in flight
            const trimmed = message.trim();
            if (!trimmed || trimmed === 'exit' || trimmed === 'quit') {
              tui.stop();
              resolveQuit();
              return;
            }
            void runTurn(trimmed, true);
          });
          await quit;
          await cleanup();
          return;
        }

        // Interactive mode (no TUI) — two-stage SIGINT:
        //   During a turn: stop watching (agent continues server-side), re-prompt.
        //   When idle at the prompt: clean up and exit.
        process.on('SIGINT', () => {
          if (currentAbort) {
            currentAbort.abort();
            currentAbort = null;
            process.stderr.write(
              '\nStopped watching (the agent continues on the server).\n',
            );
          } else {
            void cleanup().then(() => process.exit(0));
          }
        });

        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stderr,
          terminal: true,
          prompt: '> ',
        });
        // stdin may reach EOF (piped input) while a turn is awaited; guard the
        // re-prompt so it never fires after the interface has closed.
        let rlClosed = false;
        rl.on('close', () => {
          rlClosed = true;
        });

        rl.prompt();
        for await (const line of rl) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'exit' || trimmed === 'quit') break;
          await runTurn(trimmed, true);
          // Exactly one prompt per turn, after all streams have closed — this is
          // what removes the stray extra '>' the old timer-based loop produced.
          if (!rlClosed) rl.prompt();
        }

        if (!rlClosed) rl.close();
        await cleanup();
      },
    );
}
