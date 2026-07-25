import { promptWithHelp } from '../utils/prompt-with-help';
import {
  DEFAULT_AGENT_ITERATIONS,
  DEFAULT_AGENT_WORKER_CONCURRENCY,
} from '../utils/app-defaults';

export interface ResourceAnswers {
  agentIterations: number;
  agentConcurrency: number;
}

/** Prompts for resource limits. */
export async function promptResources(): Promise<ResourceAnswers> {
  return promptWithHelp<ResourceAnswers>([
    {
      type: 'number',
      name: 'agentIterations',
      message: 'Maximum number of iterations an agent can perform?',
      default: DEFAULT_AGENT_ITERATIONS,
      validate: (input: number) =>
        (Number.isInteger(input) && input > 0) || 'Must be a positive integer',
      help: `How many reasoning steps a single agent can take.
  - Higher values allow more complex tasks but use more tokens
  - Default: ${DEFAULT_AGENT_ITERATIONS}
  - Reduce if you want faster, cheaper responses`,
    },
    {
      type: 'number',
      name: 'agentConcurrency',
      message: 'Maximum number of concurrent agents?',
      default: DEFAULT_AGENT_WORKER_CONCURRENCY,
      validate: (input: number) =>
        (Number.isInteger(input) && input > 0) || 'Must be a positive integer',
      help: `How many agents run simultaneously.
  - Higher values improve throughput but use more resources
  - Default: ${DEFAULT_AGENT_WORKER_CONCURRENCY}
  - Set to 1 when sharing one capacity-limited local model`,
    },
  ]);
}
