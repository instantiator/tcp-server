import { describeWizardError } from './describe-wizard-error';

/** An error shaped like the ones Node's fs module throws. */
function fsError(code: string, path: string): Error {
  return Object.assign(new Error(`${code}: open '${path}'`), { code, path });
}

/** An error shaped like inquirer's Ctrl+C. */
function exitPromptError(): Error {
  const err = new Error('User force closed the prompt');
  err.name = 'ExitPromptError';
  return err;
}

describe('describeWizardError', () => {
  it('reports Ctrl+C before anything was written', () => {
    expect(describeWizardError(exitPromptError())).toEqual({
      message: 'Setup cancelled. Nothing was written.',
      exitCode: 130,
    });
  });

  it('reports Ctrl+C after the env file was written', () => {
    expect(
      describeWizardError(exitPromptError(), '/repo/.env.dev').message,
    ).toBe('Setup cancelled. Your answers were written to /repo/.env.dev.');
  });

  it('names the file and the problem for a permission error', () => {
    const report = describeWizardError(fsError('EACCES', '/repo/.env.dev'));
    expect(report.message).toContain("Couldn't write /repo/.env.dev");
    expect(report.message).toContain('permission denied');
    expect(report.exitCode).toBe(1);
  });

  it('shows the message, not a stack trace, for anything else', () => {
    const report = describeWizardError(new Error('boom'));
    expect(report.message).toContain('Setup failed: boom');
    expect(report.message).toContain('DEBUG=1');
    expect(report.message).not.toContain('at ');
  });

  it('copes with a thrown non-Error', () => {
    expect(describeWizardError('plain string').message).toContain(
      'Setup failed: plain string',
    );
  });
});
