import { ArtifactResolutionContext } from '../storage/artifact-keys';
import { MODE_PROMPTS } from './mode-prompts';
import {
  PromptAssemblyStrings,
  buildAssignmentMessage,
  buildRagMessage,
  buildServicesMessage,
} from './prompt-assembly';

/** Minimal strings for the builders under test. */
const strings: PromptAssemblyStrings = {
  services_header: '## Available Services',
  services_intro: 'Intro.',
  services_item: '- **{{name}}**: use for {{usage}}',
  services_item_unknown: '- **{{name}}**: call describe_server',
  rag_intro: 'Relevant excerpts:',
  rag_source_header: '### Source: {{documentPath}}',
  assignment_materials_header: '## Materials',
  assignment_expected_header: '## Expected outputs',
};

/** Orphan-assignment resolution context (no task/plan). */
const orphanCtx: ArtifactResolutionContext = {
  companySlug: 'acme',
  task: null,
  assignment: { id: 'assign-1', taskId: null, orderIndex: null },
};

describe('buildAssignmentMessage', () => {
  it('prepends the mode prompt to the assignment prompt', () => {
    const msg = buildAssignmentMessage(
      {
        mode: 'implement',
        prompt: 'Summarise the market.',
        materials: [],
        expected: [],
        resolutionContext: orphanCtx,
      },
      strings,
    );
    expect(msg).toBe(`${MODE_PROMPTS.implement}\n\nSummarise the market.`);
  });

  it('selects the mode prompt by mode', () => {
    for (const mode of ['plan', 'qa', 'chat'] as const) {
      const msg = buildAssignmentMessage(
        {
          mode,
          prompt: 'Do the thing.',
          materials: [],
          expected: [],
          resolutionContext: orphanCtx,
        },
        strings,
      );
      expect(msg.startsWith(MODE_PROMPTS[mode])).toBe(true);
    }
  });

  it('omits the prompt block when the prompt is empty (chat-start)', () => {
    const msg = buildAssignmentMessage(
      {
        mode: 'chat',
        prompt: '',
        materials: [],
        expected: [],
        resolutionContext: orphanCtx,
      },
      strings,
    );
    expect(msg).toBe(MODE_PROMPTS.chat);
  });

  it('lists materials — resolved storage key for paths, literal for inline-text', () => {
    const msg = buildAssignmentMessage(
      {
        mode: 'implement',
        prompt: 'Work.',
        materials: [
          { type: 'assignment-working-path', value: 'notes.md' },
          { type: 'inline-text', value: 'remember the deadline' },
        ],
        expected: [],
        resolutionContext: orphanCtx,
      },
      strings,
    );
    expect(msg).toContain(strings.assignment_materials_header);
    // Orphan working path resolves to {companySlug}/assignments/{id}/working/{file}.
    expect(msg).toContain('- acme/assignments/assign-1/working/notes.md');
    expect(msg).toContain('- remember the deadline');
  });

  it('lists expected outputs', () => {
    const msg = buildAssignmentMessage(
      {
        mode: 'implement',
        prompt: 'Work.',
        materials: [],
        expected: [{ type: 'assignment-working-path', value: 'report.md' }],
        resolutionContext: orphanCtx,
      },
      strings,
    );
    expect(msg).toContain(strings.assignment_expected_header);
    expect(msg).toContain('- acme/assignments/assign-1/working/report.md');
  });

  it('omits both lists when there are no materials or expectations', () => {
    const msg = buildAssignmentMessage(
      {
        mode: 'implement',
        prompt: 'Work.',
        materials: [],
        expected: [],
        resolutionContext: orphanCtx,
      },
      strings,
    );
    expect(msg).not.toContain(strings.assignment_materials_header);
    expect(msg).not.toContain(strings.assignment_expected_header);
  });
});

describe('buildServicesMessage', () => {
  it('returns empty string when no known servers have URLs', () => {
    expect(buildServicesMessage(['storage'], {}, strings)).toBe('');
  });

  it('renders a bullet per server with a URL', () => {
    const msg = buildServicesMessage(
      ['storage'],
      { storage: 'http://localhost:1' },
      strings,
    );
    expect(msg).toContain(strings.services_header);
    expect(msg).toContain('storage');
  });
});

describe('buildRagMessage', () => {
  it('renders each chunk under its source header', () => {
    const msg = buildRagMessage(
      [
        { documentPath: 'a.md', content: 'alpha' },
        { documentPath: 'b.md', content: 'beta' },
      ],
      strings,
    );
    expect(msg).toContain('a.md');
    expect(msg).toContain('alpha');
    expect(msg).toContain('beta');
  });
});
