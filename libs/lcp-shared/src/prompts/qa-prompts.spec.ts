import { renderQaPresentation, renderQaRejectionMessage } from './qa-prompts';

describe('renderQaPresentation', () => {
  it('lists the prompt, expected outputs, and prepared artifacts', () => {
    const text = renderQaPresentation({
      prompt: 'Write the onboarding guide.',
      expected: [{ type: 'inline-text', value: 'Cover setup and FAQs' }],
      prepared: [{ type: 'assignment-working-path', value: 'guide.md' }],
    });
    expect(text).toContain('Write the onboarding guide.');
    expect(text).toContain('inline-text: Cover setup and FAQs');
    expect(text).toContain('assignment-working-path: guide.md');
  });

  it('shows a placeholder when expected/prepared are empty', () => {
    const text = renderQaPresentation({
      prompt: 'Do the thing.',
      expected: [],
      prepared: [],
    });
    expect(text).toContain('(none)');
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
