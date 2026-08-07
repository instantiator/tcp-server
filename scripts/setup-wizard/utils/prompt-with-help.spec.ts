import inquirer from 'inquirer';
import { promptWithHelp } from './prompt-with-help';

jest.mock('inquirer', () => ({
  __esModule: true,
  default: { prompt: jest.fn() },
}));

const mockedPrompt = jest.mocked(inquirer.prompt);

/** Captures the `validate` the wizard handed to inquirer for the last question. */
type AskedQuestion = {
  message: string;
  default?: unknown;
  validate: (input: string) => true | string;
};

function lastQuestion(): AskedQuestion {
  const calls = mockedPrompt.mock.calls;
  return calls[calls.length - 1][0] as unknown as AskedQuestion;
}

/** Queues one answer per prompt call, in order. */
function answerWith(...values: string[]): void {
  for (const value of values) {
    mockedPrompt.mockResolvedValueOnce({ value });
  }
}

describe('promptWithHelp', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.resetAllMocks());

  describe.each([
    ['input', 'answer'],
    ['number', '42'],
    ['confirm', 'y'],
  ] as const)('a %s question', (type, accepted) => {
    // The '?' contract is the whole point of this wrapper: show the help text,
    // then ask the same question again rather than accepting '?' as an answer.
    it('prints help and re-asks when answered with ?', async () => {
      answerWith('?', accepted);

      await promptWithHelp([
        { type, name: 'field', message: 'Pick one', help: 'Some guidance.' },
      ]);

      expect(mockedPrompt).toHaveBeenCalledTimes(2);
      expect(logSpy).toHaveBeenCalledWith('\nSome guidance.\n');
    });

    it('rejects ? during validation when the question has no help', async () => {
      answerWith(accepted);

      await promptWithHelp([{ type, name: 'field', message: 'Pick one' }]);

      expect(lastQuestion().validate('?')).toBe(
        'No help available for this question.',
      );
    });

    it('accepts ? during validation when help exists', async () => {
      answerWith(accepted);

      await promptWithHelp([
        { type, name: 'field', message: 'Pick one', help: 'Some guidance.' },
      ]);

      expect(lastQuestion().validate('?')).toBe(true);
    });
  });

  it('reads an input answer back as a string', async () => {
    answerWith('hello');
    const answers = await promptWithHelp<{ field: string }>([
      { type: 'input', name: 'field', message: 'Name' },
    ]);
    expect(answers.field).toBe('hello');
  });

  it('reads a number answer back as a number, rejecting non-positive integers', async () => {
    answerWith('7');
    const answers = await promptWithHelp<{ field: number }>([
      { type: 'number', name: 'field', message: 'Count' },
    ]);
    expect(answers.field).toBe(7);
    expect(lastQuestion().validate('0')).toBe('Must be a positive integer.');
    expect(lastQuestion().validate('1.5')).toBe('Must be a positive integer.');
  });

  it.each([
    ['y', true],
    ['yes', true],
    ['n', false],
    ['no', false],
    ['', false],
  ])('reads a confirm answer of %p as %p', async (input, expected) => {
    answerWith(input);
    const answers = await promptWithHelp<{ field: boolean }>([
      { type: 'confirm', name: 'field', message: 'Sure?' },
    ]);
    expect(answers.field).toBe(expected);
  });

  it('rejects a confirm answer that is neither y nor n', async () => {
    answerWith('y');
    await promptWithHelp([
      { type: 'confirm', name: 'field', message: 'Sure?' },
    ]);
    expect(lastQuestion().validate('maybe')).toBe('Please enter y, n, or ?.');
  });

  it('applies a caller validator to input answers', async () => {
    answerWith('ok');
    await promptWithHelp([
      {
        type: 'input',
        name: 'field',
        message: 'Key',
        validate: (v: string) => v.length > 0 || 'cannot be empty',
      },
    ]);
    expect(lastQuestion().validate('')).toBe('cannot be empty');
  });

  it('resolves a function default against the answers so far', async () => {
    answerWith('acme', 'acme-db');

    await promptWithHelp([
      { type: 'input', name: 'slug', message: 'Slug' },
      {
        type: 'input',
        name: 'db',
        message: 'Database',
        default: (answers) => `${String(answers['slug'])}-db`,
      },
    ]);

    expect(lastQuestion().default).toBe('acme-db');
  });
});
