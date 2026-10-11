import type { TcpAssignmentMode } from '../models/TcpAssignment.model';
import {
  buildAvailableRolesMessage,
  MODE_PROMPTS,
  modePrompt,
  requiredToolForMode,
} from './mode-prompts';

describe('buildAvailableRolesMessage', () => {
  it('lists each role by slug and tells the planner to use exact slugs', () => {
    const msg = buildAvailableRolesMessage([
      {
        slug: 'chicken-assistant',
        name: 'Chicken assistant',
        description: 'fowl',
      },
      { slug: 'cat-assistant', name: 'Cat assistant' },
    ]);
    expect(msg).toContain('the exact slug');
    expect(msg).toContain('- chicken-assistant — Chicken assistant: fowl');
    expect(msg).toContain('- cat-assistant — Cat assistant');
    expect(msg).toContain('do not invent role names');
  });

  it('returns empty string when there are no roles', () => {
    expect(buildAvailableRolesMessage([])).toBe('');
  });
});

describe('MODE_PROMPTS', () => {
  it('has a non-empty prompt for every mode', () => {
    for (const mode of [
      'plan',
      'implement',
      'qa',
      'chat',
      'consultee',
      'finalise',
    ] as const) {
      expect(MODE_PROMPTS[mode].length).toBeGreaterThan(0);
    }
  });

  it('frames consultee as answering a consultation via complete_assignment', () => {
    const consultee = MODE_PROMPTS.consultee.toLowerCase();
    expect(consultee).toContain('consulted you');
    expect(consultee).toContain('summary');
    expect(consultee).toContain('complete_assignment');
  });

  it('frames finalise as meeting the task expected outputs via complete_assignment', () => {
    const finalise = MODE_PROMPTS.finalise.toLowerCase();
    expect(finalise).toContain('expected outputs');
    expect(finalise).toContain('rename_working_file');
    expect(finalise).toContain('complete_assignment');
  });

  it('names the completion tool and describe_server per work mode', () => {
    expect(MODE_PROMPTS.implement).toContain('complete_assignment');
    expect(MODE_PROMPTS.plan).toContain('create_plan');
    expect(MODE_PROMPTS.qa).toContain('assure_assignment');
    for (const mode of ['plan', 'implement', 'qa'] as const) {
      expect(MODE_PROMPTS[mode]).toContain('describe_server');
    }
  });

  it('spells out the chat behaviours: interact, consult, act, no completion tool', () => {
    const chat = MODE_PROMPTS.chat.toLowerCase();
    expect(chat).toContain('conversation');
    expect(chat).toContain('consult');
    expect(chat).toContain('take the action');
    expect(chat).toContain('no completion tool');
  });

  it('tells every tool-using mode to invoke tools rather than narrate them, by exact name', () => {
    for (const mode of ['plan', 'implement', 'qa', 'chat'] as const) {
      const text = MODE_PROMPTS[mode].toLowerCase();
      expect(text).toContain('actually invoke');
      expect(text).toContain('exact');
    }
  });

  it('tells implement mode to right-size output (no file for a short answer)', () => {
    const implement = MODE_PROMPTS.implement.toLowerCase();
    expect(implement).toContain('summary');
    expect(implement).toContain('text');
    expect(implement).toContain('do not need to create a file');
  });

  it('restricts plan mode: plan-only, no consulting agents, no user questions, no file writes', () => {
    const plan = MODE_PROMPTS.plan.toLowerCase();
    expect(plan).toContain('only job');
    expect(plan).toContain('cannot consult');
    expect(plan).not.toContain('put questions to the user to resolve');
  });
});

describe('modePrompt', () => {
  const MODES: TcpAssignmentMode[] = [
    'plan',
    'implement',
    'qa',
    'chat',
    'consultee',
    'finalise',
  ];
  const ALL = [
    'tasks',
    'storage',
    'memory',
    'interactions',
    'utilities',
    'records',
  ];

  it('is the full prompt when every server is loaded, or no list is given', () => {
    for (const mode of MODES) {
      expect(modePrompt(mode, ALL)).toBe(MODE_PROMPTS[mode]);
      expect(modePrompt(mode)).toBe(MODE_PROMPTS[mode]);
    }
  });

  it('still names the completion tool with no servers at all', () => {
    for (const mode of MODES) {
      for (const tool of requiredToolForMode(mode)) {
        expect(modePrompt(mode, [])).toContain(tool);
      }
    }
  });

  it('says nothing about records when records is switched off', () => {
    for (const mode of MODES) {
      const text = modePrompt(
        mode,
        ALL.filter((s) => s !== 'records'),
      );
      expect(text).not.toMatch(/list_tables|aggregate|\brecords?\b/i);
    }
  });

  it('says nothing about files or resources when storage is switched off', () => {
    for (const mode of MODES) {
      const text = modePrompt(
        mode,
        ALL.filter((s) => s !== 'storage'),
      );
      expect(text).not.toMatch(/_resource|working_file|list_resources/);
    }
  });

  it('tells implement and plan about records and resources when they have them', () => {
    for (const mode of ['implement', 'plan'] as const) {
      const text = modePrompt(mode, ALL);
      expect(text).toContain('list_resources');
      expect(text).toContain('list_tables');
    }
    expect(modePrompt('plan', ALL)).toContain('"type": "resource"');
  });

  it('tells qa and finalise that resource changes are drafts and records are already saved', () => {
    for (const mode of ['qa', 'finalise'] as const) {
      const text = modePrompt(mode, ALL);
      expect(text).toContain('read_resource');
      expect(text).toMatch(/already saved/);
    }
  });

  it('leaves out consultation when interactions is switched off', () => {
    expect(
      modePrompt(
        'chat',
        ALL.filter((s) => s !== 'interactions'),
      ),
    ).not.toContain('consult');
  });
});

describe('requiredToolForMode', () => {
  it('maps each work mode to its required completion tool', () => {
    expect(requiredToolForMode('implement')).toEqual(['complete_assignment']);
    expect(requiredToolForMode('plan')).toEqual(['create_plan']);
    expect(requiredToolForMode('qa')).toEqual(['assure_assignment']);
  });

  it('requires complete_assignment for consultee and finalise', () => {
    expect(requiredToolForMode('consultee')).toEqual(['complete_assignment']);
    expect(requiredToolForMode('finalise')).toEqual(['complete_assignment']);
  });

  it('requires no tool for chat mode', () => {
    expect(requiredToolForMode('chat')).toEqual([]);
  });
});
