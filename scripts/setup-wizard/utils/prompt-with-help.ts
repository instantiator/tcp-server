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
      return askConfirm(q, answers);
    case 'checkbox':
      return askCheckbox(q, answers);
    default:
      throw new Error(`Unsupported prompt type: ${(q as Prompt).type}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic prompt wrapper needs flexible answer types
async function askInput(
  q: InputPrompt,
  answers: Record<string, any>,
): Promise<string> {
  const { value } = await inquirer.prompt<{ value: string }>({
    type: 'input',
    name: 'value',
    message: q.message,
    default:
      typeof q.default === 'function'
        ? q.default(answers)
        : q.default,
    validate: (input: string) => {
      if (input.trim() === '?' && q.help) return true;
      if (input.trim() === '?') return 'No help available for this question.';
      return q.validate ? q.validate(input) : true;
    },
  });

  if (value.trim() === '?' && q.help) {
    console.log(`\n${q.help}\n`);
    return askInput(q, answers);
  }

  return value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic prompt wrapper needs flexible answer types
async function askNumber(
  q: NumberPrompt,
  answers: Record<string, any>,
): Promise<number> {
  const { value } = await inquirer.prompt<{ value: string }>({
    type: 'input',
    name: 'value',
    message: q.message,
    default:
      typeof q.default === 'function'
        ? q.default(answers)
        : q.default,
    validate: (input: string) => {
      if (input.trim() === '?' && q.help) return true;
      if (input.trim() === '?') return 'No help available for this question.';
      const n = Number(input);
      if (!Number.isInteger(n) || n <= 0) return 'Must be a positive integer.';
      return q.validate ? q.validate(n) : true;
    },
  });

  if (String(value).trim() === '?' && q.help) {
    console.log(`\n${q.help}\n`);
    return askNumber(q, answers);
  }

  return Number(value);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic prompt wrapper needs flexible answer types
async function askConfirm(
  q: ConfirmPrompt,
  answers: Record<string, any>,
): Promise<boolean> {
  const { value } = await inquirer.prompt<{ value: string }>({
    type: 'input',
    name: 'value',
    message: `${q.message} (y/n/?)`,
    default:
      q.default === true
        ? 'y'
        : q.default === false
          ? 'n'
          : undefined,
    validate: (input: string) => {
      const lower = input.trim().toLowerCase();
      if (lower === '?' && q.help) return true;
      if (lower === '?') return 'No help available for this question.';
      if (['y', 'yes', 'n', 'no', ''].includes(lower)) return true;
      return 'Please enter y, n, or ?.';
    },
  });

  const lower = String(value).trim().toLowerCase();

  if (lower === '?' && q.help) {
    console.log(`\n${q.help}\n`);
    return askConfirm(q, answers);
  }

  return lower === 'y' || lower === 'yes';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic prompt wrapper needs flexible answer types
async function askCheckbox(
  q: CheckboxPrompt,
  answers: Record<string, any>,
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
