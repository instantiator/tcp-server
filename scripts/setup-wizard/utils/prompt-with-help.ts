import inquirer from 'inquirer';

interface PromptBase {
  type: string;
  name: string;
  message: string;
  /** Help text shown when the user answers with `?`. */
  help?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic prompt wrapper needs flexible default callbacks
type DefaultFn<T> = (answers: Record<string, any>) => T;

interface InputPrompt extends PromptBase {
  type: 'input';
  default?: string | DefaultFn<string>;
  validate?: (input: string) => true | string;
}

interface NumberPrompt extends PromptBase {
  type: 'number';
  default?: number | DefaultFn<number>;
  validate?: (input: number) => true | string;
}

interface ConfirmPrompt extends PromptBase {
  type: 'confirm';
  default?: boolean;
  validate?: (input: boolean) => true | string;
}

interface CheckboxPrompt extends PromptBase {
  type: 'checkbox';
  choices: Array<{ name: string; checked?: boolean }>;
  validate?: (input: string[]) => true | string;
}

type Prompt = InputPrompt | NumberPrompt | ConfirmPrompt | CheckboxPrompt;

/**
 * Wraps inquirer prompts with a `?` help system. When a user answers `?`,
 * the question's `help` text is printed and the question is re-asked.
 *
 * For checkbox prompts, a y/n help question is shown beforehand since
 * checkbox uses arrow-key navigation where `?` doesn't fit naturally.
 */
export async function promptWithHelp<T extends object>(
  questions: Prompt[],
): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic prompt wrapper needs flexible answer accumulation
  const answers: Record<string, any> = {};

  for (const q of questions) {
    const raw = await ask(q, answers);
    answers[q.name] = raw as string | number | boolean;
  }

  return answers as T;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic prompt wrapper needs flexible answer types
function ask(
  q: Prompt,
  answers: Record<string, any>,
): Promise<string | number | boolean | string[]> {
  switch (q.type) {
    case 'input':
      return askInput(q, answers);
    case 'number':
      return askNumber(q, answers);
    case 'confirm':
      return askConfirm(q);
    case 'checkbox':
      return askCheckbox(q, answers);
    default:
      throw new Error(`Unsupported prompt type: ${(q as Prompt).type}`);
  }
}

/**
 * Asks one free-text question, printing `help` and re-asking whenever the user
 * answers `?`.
 *
 * The three typed prompts below differ only in their default, their validation
 * and how they read the answer back — the `?` contract itself lives here, so a
 * new prompt type cannot quietly omit it.
 */
async function askWithHelp<T>(
  q: PromptBase,
  spec: {
    message: string;
    default?: string | number;
    /** Validates an answer that is not a help request. */
    validate: (input: string) => true | string;
    /** Reads the accepted answer back as its final type. */
    parse: (input: string) => T;
  },
): Promise<T> {
  const { value } = await inquirer.prompt<{ value: string }>({
    type: 'input',
    name: 'value',
    message: spec.message,
    default: spec.default,
    validate: (input: string) => {
      if (input.trim() === '?') {
        return q.help ? true : 'No help available for this question.';
      }
      return spec.validate(input);
    },
  });

  if (String(value).trim() === '?' && q.help) {
    console.log(`\n${q.help}\n`);
    return askWithHelp(q, spec);
  }

  return spec.parse(String(value));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic prompt wrapper needs flexible answer types
function askInput(
  q: InputPrompt,
  answers: Record<string, any>,
): Promise<string> {
  return askWithHelp(q, {
    message: q.message,
    default: typeof q.default === 'function' ? q.default(answers) : q.default,
    validate: (input: string) => (q.validate ? q.validate(input) : true),
    parse: (input: string) => input,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic prompt wrapper needs flexible answer types
function askNumber(
  q: NumberPrompt,
  answers: Record<string, any>,
): Promise<number> {
  return askWithHelp(q, {
    message: q.message,
    default: typeof q.default === 'function' ? q.default(answers) : q.default,
    validate: (input: string) => {
      const n = Number(input);
      if (!Number.isInteger(n) || n <= 0) return 'Must be a positive integer.';
      return q.validate ? q.validate(n) : true;
    },
    parse: Number,
  });
}

function askConfirm(q: ConfirmPrompt): Promise<boolean> {
  return askWithHelp(q, {
    message: `${q.message} (y/n/?)`,
    default: q.default === true ? 'y' : q.default === false ? 'n' : undefined,
    validate: (input: string) =>
      ['y', 'yes', 'n', 'no', ''].includes(input.trim().toLowerCase())
        ? true
        : 'Please enter y, n, or ?.',
    parse: (input: string) => ['y', 'yes'].includes(input.trim().toLowerCase()),
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic prompt wrapper needs flexible answer types
async function askCheckbox(
  q: CheckboxPrompt,
  _answers: Record<string, any>,
): Promise<string[]> {
  if (q.help) {
    const { wantHelp } = await inquirer.prompt<{ wantHelp: string }>({
      type: 'input',
      name: 'wantHelp',
      message: `${q.message} — need more info first? (y/n)`,
      default: 'n',
      validate: (input: string) => {
        const lower = input.trim().toLowerCase();
        if (['y', 'yes', 'n', 'no', ''].includes(lower)) return true;
        return 'Please enter y or n.';
      },
    });

    if (wantHelp.trim().toLowerCase() === 'y' || wantHelp.trim().toLowerCase() === 'yes') {
      console.log(`\n${q.help}\n`);
    }
  }

  const { selected } = await inquirer.prompt<{ selected: string[] }>({
    type: 'checkbox',
    name: 'selected',
    message: q.message,
    choices: q.choices,
    validate: q.validate
      ? (input: string[]) => q.validate!(input)
      : (input: string[]) => input.length > 0 || 'Select at least one service',
  });

  return selected;
}
