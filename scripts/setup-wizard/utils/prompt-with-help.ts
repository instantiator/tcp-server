import inquirer from 'inquirer';

interface PromptBase {
  type: string;
  name: string;
  message: string;
  /** Help text shown when the user answers with `?`. */
  help?: string;
}

/**
 * Everything a prompt can answer with. Every branch of {@link ask} returns one
 * of these four, so the accumulator needs no wider type — `any` here used to
 * hide that `string[]` was a possible answer, which is why the assignment in
 * {@link promptWithHelp} asserted a union that omitted it.
 */
type Answer = string | number | boolean | string[];

/** The answers given so far, keyed by question name. */
type Answers = Record<string, Answer>;

type DefaultFn<T> = (answers: Answers) => T;

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
  const answers: Answers = {};

  for (const q of questions) {
    answers[q.name] = await ask(q, answers);
  }

  return answers as T;
}

function ask(q: Prompt, answers: Answers): Promise<Answer> {
  switch (q.type) {
    case 'input':
      return askInput(q, answers);
    case 'number':
      return askNumber(q, answers);
    case 'confirm':
      return askConfirm(q);
    case 'checkbox':
      return askCheckbox(q);
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

function askInput(q: InputPrompt, answers: Answers): Promise<string> {
  return askWithHelp(q, {
    message: q.message,
    default: typeof q.default === 'function' ? q.default(answers) : q.default,
    validate: (input: string) => (q.validate ? q.validate(input) : true),
    parse: (input: string) => input,
  });
}

function askNumber(q: NumberPrompt, answers: Answers): Promise<number> {
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

// Takes no answers: a checkbox has no dynamic default to compute from them,
// which is why `ask` calls it with only the question — as it does askConfirm.
async function askCheckbox(q: CheckboxPrompt): Promise<string[]> {
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

    if (
      wantHelp.trim().toLowerCase() === 'y' ||
      wantHelp.trim().toLowerCase() === 'yes'
    ) {
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
