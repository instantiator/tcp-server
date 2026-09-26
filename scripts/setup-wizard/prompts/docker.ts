import { promptWithHelp } from '../utils/prompt-with-help';

/**
 * Tells the user which Docker services always run, and asks about the one that
 * is optional: the stub LLM. Offered by default only when no real inference
 * model was configured, since then agents have nothing else to talk to.
 */
export async function promptDocker(
  inferenceConfigured: boolean,
  externalOidc: boolean,
): Promise<{ stubLlm: boolean }> {
  console.log();
  console.log(
    `Docker services: PostgreSQL, Redis and MinIO always run${externalOidc ? '' : ', and Zitadel (the bundled sign-in provider)'}.`,
  );

  return promptWithHelp<{ stubLlm: boolean }>([
    {
      type: 'confirm',
      name: 'stubLlm',
      message: 'Also run the stub LLM (canned replies, no real model needed)?',
      default: !inferenceConfigured,
      help: `The stub LLM answers every prompt with a fixed message from
docker/stub-llm/dev.jsonc, so you can try TCP without a real model.
Agents can chat, but they can't do real work with it.
If you configured no inference model, TCP's default LLM points at the stub.`,
    },
  ]);
}
