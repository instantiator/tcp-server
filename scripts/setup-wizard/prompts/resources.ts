import { promptWithHelp } from '../utils/prompt-with-help';
import {
  DEFAULT_AGENT_ITERATIONS,
  DEFAULT_LOCAL_MODEL_CONCURRENCY,
  DEFAULT_REMOTE_MODEL_CONCURRENCY,
} from '../utils/app-defaults';

export interface ResourceAnswers {
  agentIterations: number;
  localModelConcurrency: number;
  remoteModelConcurrency: number;
}

/** Prompts for resource limits. */
export async function promptResources(): Promise<ResourceAnswers> {
  const positiveInteger = (input: number) =>
    (Number.isInteger(input) && input > 0) || 'Must be a positive integer';
  return promptWithHelp<ResourceAnswers>([
    {
      type: 'number',
      name: 'agentIterations',
      message: 'Maximum number of iterations an agent can perform?',
      default: DEFAULT_AGENT_ITERATIONS,
      validate: positiveInteger,
      help: `How many reasoning steps a single agent can take.
  - Higher values allow more complex tasks but use more tokens
  - Default: ${DEFAULT_AGENT_ITERATIONS}
  - Reduce if you want faster, cheaper responses`,
    },
    {
      type: 'number',
      name: 'localModelConcurrency',
      message: 'Maximum concurrent agents against local models?',
      default: DEFAULT_LOCAL_MODEL_CONCURRENCY,
      validate: positiveInteger,
      help: `How many agents run at once against every local model endpoint combined.
  - Higher values improve throughput but use more resources
  - Default: ${DEFAULT_LOCAL_MODEL_CONCURRENCY}
  - Set to 1 when sharing one capacity-limited local model (e.g. one GPU)`,
    },
    {
      type: 'number',
      name: 'remoteModelConcurrency',
      message: 'Maximum concurrent agents against remote models?',
      default: DEFAULT_REMOTE_MODEL_CONCURRENCY,
      validate: positiveInteger,
      help: `How many agents run at once against every remote model endpoint combined.
  - Higher values improve throughput but also raise your spend rate
  - Default: ${DEFAULT_REMOTE_MODEL_CONCURRENCY}`,
    },
  ]);
}
