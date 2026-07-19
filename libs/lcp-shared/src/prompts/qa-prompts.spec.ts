import { renderQaPresentation, renderQaRejectionMessage } from './qa-prompts';

describe('renderQaPresentation', () => {
  it('shows a path-type artifact as its bare filename, not a resolved storage key', () => {
    const text = renderQaPresentation({
      prompt: 'Write the onboarding guide.',
      expected: [{ type: 'inline-text', value: 'Cover setup and FAQs' }],
      prepared: [{ type: 'assignment-working-path', value: 'guide.md' }],
    });
    expect(text).toContain('Write the onboarding guide.');
    expect(text).toContain('Cover setup and FAQs');
    expect(text).toContain('  - guide.md');
    // No resolved storage key (company/task/assignment path segments) leaks
    // into the prompt — this is exactly what a QA agent used to (wrongly)
    // echo back as a `read_working_file` filename.
    expect(text).not.toContain('/working/');
    expect(text).not.toContain('assignment-working-path:');
  });

  it('shows an inline-text artifact as its literal value, with nothing to read', () => {
    const text = renderQaPresentation({
      prompt: 'Do the thing.',
      expected: [],
      prepared: [{ type: 'inline-text', value: 'The answer is 42.' }],
    });
    expect(text).toContain('  - The answer is 42.');
  });

  it('shows a placeholder when expected/prepared are empty', () => {
    const text = renderQaPresentation({
      prompt: 'Do the thing.',
      expected: [],
      prepared: [],
    });
    expect(text).toContain('(none)');
  });

  it('points the reviewer at read_working_file by name', () => {
    const text = renderQaPresentation({
      prompt: 'Do the thing.',
      expected: [],
      prepared: [],
    });
    expect(text).toContain('read_working_file');
  });
});

describe('renderQaRejectionMessage', () => {
  it('quotes the QA feedback', () => {
    expect(renderQaRejectionMessage('Missing the summary section.')).toContain(
      'Missing the summary section.',
    );
  });

  it('falls back to a placeholder when feedback is null or blank', () => {
    expect(renderQaRejectionMessage(null)).toContain(
      '(no specific feedback was given)',
    );
    expect(renderQaRejectionMessage('   ')).toContain(
      '(no specific feedback was given)',
    );
  });
});
