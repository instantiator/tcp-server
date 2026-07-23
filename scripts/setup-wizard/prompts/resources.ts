import { promptWithHelp } from '../utils/prompt-with-help';

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
      default: 40,
      validate: (input: number) =>
        (Number.isInteger(input) && input > 0) || 'Must be a positive integer',
      help: `How many reasoning steps a single agent can take.
  - Higher values allow more complex tasks but use more tokens
  - Default: 40
  - Reduce if you want faster, cheaper responses`,
    },
    {
      type: 'number',
      name: 'agentConcurrency',
      message: 'Maximum number of concurrent agents?',
      default: 5,
      validate: (input: number) =>
        (Number.isInteger(input) && input > 0) || 'Must be a positive integer',
      help: `How many agents run simultaneously.
  - Higher values improve throughput but use more resources
  - Default: 5
  - Reduce on machines with limited CPU/memory`,
    },
  ]);
}
