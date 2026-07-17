import type { ArtifactResolutionContext } from '../storage/artifact-keys';
import { renderQaPresentation, renderQaRejectionMessage } from './qa-prompts';

const ctx: ArtifactResolutionContext = {
  companySlug: 'acme',
  task: { id: 'task-1' },
  assignment: { id: 'assignment-1', taskId: 'task-1', orderIndex: 0 },
};

describe('renderQaPresentation', () => {
  it('shows a path-type artifact as its resolved storage key, with read instructions', () => {
    const text = renderQaPresentation(
      {
        prompt: 'Write the onboarding guide.',
        expected: [{ type: 'inline-text', value: 'Cover setup and FAQs' }],
        prepared: [{ type: 'assignment-working-path', value: 'guide.md' }],
      },
      ctx,
    );
    expect(text).toContain('Write the onboarding guide.');
    expect(text).toContain('Cover setup and FAQs');
    expect(text).toContain(
      'guide.md — read via the storage service\'s read_file tool, path: "acme/tasks/task-1/assignments/0/working/guide.md"',
    );
    // The old, unresolvable rendering must be gone — this is exactly what
    // the QA agent used to (wrongly) treat as a path.
    expect(text).not.toContain('assignment-working-path:');
  });

  it('shows an inline-text artifact as its literal value, with nothing to read', () => {
    const text = renderQaPresentation(
      {
        prompt: 'Do the thing.',
        expected: [],
        prepared: [{ type: 'inline-text', value: 'The answer is 42.' }],
      },
      ctx,
    );
    expect(text).toContain('  - The answer is 42.');
    // No "read via read_file" annotation on an inline-text line — there's
    // nothing to read, the content is already right there.
    expect(text).not.toContain('The answer is 42. — read via');
  });

  it('shows a placeholder when expected/prepared are empty', () => {
    const text = renderQaPresentation(
      { prompt: 'Do the thing.', expected: [], prepared: [] },
      ctx,
    );
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
