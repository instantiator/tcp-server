import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AuditWireEvent, WireEvent } from '@tcp/shared/client';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { subscribe } from '../../events/subscriptions';
import { t } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import {
  installFetchMock,
  respondByRoute,
} from '../../test-support/fetch-mock';
import { ReasoningRuleMenu } from './ReasoningRuleMenu';
import {
  REASONING_RULE_STORAGE_KEY,
  resetReasoningRule,
  setReasoningRule,
} from './reasoningRule';
import { Transcript } from './Transcript';

vi.mock('../../events/subscriptions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../events/subscriptions')>()),
  subscribe: vi.fn(),
}));

const subscribeMock = vi.mocked(subscribe);

const AGENT_ID = 'agent-1';
const ROLE = 'Sales';

let emit: ((event: WireEvent) => void) | undefined;
let fail: ((error: Error) => void) | undefined;

const auditEvent = (
  overrides: Partial<AuditWireEvent> & Pick<AuditWireEvent, 'eventType'>,
): AuditWireEvent => ({
  id: `audit-${overrides.eventType}`,
  timestamp: '2026-08-07T09:00:00.000Z',
  companyId: 'company-1',
  role: 'sales',
  agentId: AGENT_ID,
  assignmentId: null,
  taskId: null,
  payload: {},
  ...overrides,
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    {children}
  </QueryClientProvider>
);

const renderTranscript = async (
  history: AuditWireEvent[] = [],
  status = 200,
) => {
  respondByRoute([[/\/api\/agent\/.*\/history/, { status, body: history }]]);

  const result = render(<Transcript agentId={AGENT_ID} roleName={ROLE} />, {
    wrapper,
  });
  await waitFor(() => {
    expect(
      screen.queryByRole('progressbar', {
        name: t('state.loading', { label: t('transcript.loading') }),
      }),
    ).toBeNull();
  });
  return result;
};

/** The list item whose meta line names this event label. */
const entryFor = (label: string): HTMLElement => {
  const item = screen
    .getAllByRole('listitem')
    .find((li) => li.textContent?.includes(label));
  expect(item, `no transcript entry labelled "${label}"`).toBeDefined();
  return item as HTMLElement;
};

describe('Transcript', () => {
  beforeEach(() => {
    installFetchMock();
    emit = undefined;
    fail = undefined;
    subscribeMock.mockImplementation((_url, onEvent, onError) => {
      emit = onEvent;
      fail = onError as (error: Error) => void;
      return vi.fn();
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('names the conversation after the role, so two are told apart', async () => {
    await renderTranscript([
      auditEvent({ eventType: 'input', payload: { text: 'Hello' } }),
    ]);

    expect(
      screen.getByRole('list', {
        name: t('transcript.label', { role: ROLE }),
      }),
    ).toBeTruthy();
  });

  it('says so when the agent has done nothing yet', async () => {
    await renderTranscript();

    expect(
      screen.getByRole('heading', { name: t('transcript.empty.heading') }),
    ).toBeTruthy();
  });

  describe('each event kind the streams carry', () => {
    it('renders user input', async () => {
      await renderTranscript([
        auditEvent({ eventType: 'input', payload: { text: 'Draft a plan' } }),
      ]);

      expect(entryFor('input').textContent).toContain('Draft a plan');
    });

    it('renders a model request as a bare line', async () => {
      await renderTranscript([auditEvent({ eventType: 'llm_request' })]);

      const entry = entryFor('llm_request');
      expect(entry.querySelector('.transcript__text')).toBeNull();
    });

    it('renders a response as its reasoning and its answer', async () => {
      await renderTranscript([
        auditEvent({
          eventType: 'llm_response',
          payload: {
            reasoningText: 'Thinking it through',
            responseText: 'Here is the plan',
          },
        }),
      ]);

      expect(entryFor('llm_response:reasoning').textContent).toContain(
        'Thinking it through',
      );
      expect(entryFor('llm_response:response').textContent).toContain(
        'Here is the plan',
      );
    });

    it('shows the placeholder for an answer that was empty', async () => {
      await renderTranscript([
        auditEvent({
          eventType: 'llm_response',
          payload: { responseText: '   ' },
        }),
      ]);

      expect(entryFor('llm_response:response').textContent).toContain(
        t('transcript.blank'),
      );
    });

    it('renders a tool call as verbatim JSON, naming the tool', async () => {
      await renderTranscript([
        auditEvent({
          eventType: 'tool_call',
          payload: { tool: 'search', input: { query: 'pricing' } },
        }),
      ]);

      const entry = entryFor('tool_call:search');
      const json = entry.querySelector('.transcript__json');
      expect(json?.textContent).toContain('"query": "pricing"');
    });

    it('renders a tool result', async () => {
      await renderTranscript([
        auditEvent({
          eventType: 'tool_result',
          payload: { tool: 'search', output: { hits: 2 } },
        }),
      ]);

      expect(entryFor('tool_result:search').textContent).toContain('"hits": 2');
    });

    it('summarises a tool result in a table, with the full JSON behind a disclosure', async () => {
      await renderTranscript([
        auditEvent({
          eventType: 'tool_result',
          payload: {
            tool: 'tasks__create_plan',
            output: {
              lc: 1,
              kwargs: { status: 'success', content: 'Plan created' },
            },
          },
        }),
      ]);

      const entry = entryFor('tool_result:tasks__create_plan');
      const rows = within(entry).getAllByRole('row');
      expect(rows.map((row) => row.textContent)).toEqual([
        `${t('transcript.tool.responseField')}${t('transcript.tool.value')}`,
        `${t('transcript.tool.name')}tasks__create_plan`,
        `${t('transcript.tool.status')}success`,
        `${t('transcript.tool.content')}Plan created`,
      ]);
      expect(
        within(entry).getByRole('rowheader', {
          name: t('transcript.tool.content'),
        }),
      ).toBeTruthy();
      const details = within(entry)
        .getByText(t('transcript.tool.fullJson'))
        .closest('details');
      expect(details?.open).toBe(false);
      expect(details?.querySelector('pre')?.textContent).toContain(
        '"content": "Plan created"',
      );
    });

    it('names only the tool for a tool call', async () => {
      await renderTranscript([
        auditEvent({
          eventType: 'tool_call',
          payload: { tool: 'search', input: { query: 'pricing' } },
        }),
      ]);

      const entry = entryFor('tool_call:search');
      expect(
        within(entry)
          .getAllByRole('rowheader')
          .map((cell) => cell.textContent),
      ).toEqual([t('transcript.tool.name')]);
      expect(
        within(entry).getByRole('columnheader', {
          name: t('transcript.tool.requestField'),
        }),
      ).toBeTruthy();
    });

    it('renders a decision', async () => {
      await renderTranscript([
        auditEvent({
          eventType: 'decision',
          payload: { summary: 'Escalating to a human' },
        }),
      ]);

      expect(entryFor('decision').textContent).toContain(
        'Escalating to a human',
      );
    });

    it('renders a status change with its reason', async () => {
      await renderTranscript([
        auditEvent({
          eventType: 'state_change',
          payload: { entity: 'agent', newStatus: 'paused', reason: 'awaiting' },
        }),
      ]);

      expect(entryFor('state_change:agent').textContent).toContain(
        'paused (awaiting)',
      );
    });

    it('renders a compaction with its metrics', async () => {
      await renderTranscript([
        auditEvent({
          eventType: 'compaction',
          payload: {
            phase: 'finished',
            tokensAfter: 400,
            windowSize: 1000,
            pct: 40,
          },
        }),
      ]);

      expect(entryFor('compaction:finished').textContent).toContain(
        '400/1000 tokens (40%)',
      );
    });

    it('renders a completed assignment under its own label', async () => {
      await renderTranscript([
        auditEvent({
          eventType: 'agent_loop_completion',
          payload: { summary: 'Plan delivered' },
        }),
      ]);

      expect(entryFor('assignment complete').textContent).toContain(
        'Plan delivered',
      );
    });
  });

  describe('markdown', () => {
    const responseWith = (responseText: string) =>
      renderTranscript([
        auditEvent({ eventType: 'llm_response', payload: { responseText } }),
      ]);

    it('renders emphasis and lists', async () => {
      await responseWith('**Ready**\n\n- one\n- two');

      const entry = entryFor('llm_response:response');
      expect(entry.querySelector('strong')?.textContent).toBe('Ready');
      expect(
        [...entry.querySelectorAll('li')].map((li) => li.textContent),
      ).toEqual(['one', 'two']);
    });

    it('keeps a single newline as a line break', async () => {
      await responseWith('first line\nsecond line');

      expect(
        entryFor('llm_response:response').querySelector('br'),
      ).not.toBeNull();
    });

    it('shows an image as its alt text and never loads it', async () => {
      await responseWith('![a chart](https://example.com/leak?d=secret)');

      const entry = entryFor('llm_response:response');
      expect(entry.querySelector('img')).toBeNull();
      expect(entry.textContent).toContain('a chart');
    });

    it('opens links in a new tab with no opener or referrer', async () => {
      await responseWith('[docs](https://example.com)');

      const link = within(entryFor('llm_response:response')).getByRole('link', {
        name: 'docs',
      });
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      expect(link.getAttribute('target')).toBe('_blank');
    });

    it('renders no raw HTML', async () => {
      await responseWith('<b>bold</b> <script>alert(1)</script>');

      const entry = entryFor('llm_response:response');
      expect(entry.querySelector('b, script')).toBeNull();
    });

    it('puts every heading level at h4, below the view heading', async () => {
      await responseWith('# Title\n\n### Sub');

      expect(
        within(entryFor('llm_response:response'))
          .getAllByRole('heading')
          .map((h) => [h.tagName, h.textContent]),
      ).toEqual([
        ['H4', 'Title'],
        ['H4', 'Sub'],
      ]);
    });

    it('renders markdown while it streams, finishing it once it closes', async () => {
      await renderTranscript();

      act(() => {
        emit?.({
          type: 'stream',
          agentId: AGENT_ID,
          channel: 'response',
          delta: 'A **bo',
          timestamp: '2026-08-07T09:00:01.000Z',
        });
      });
      const entry = () => entryFor('llm_response:response');
      expect(entry().querySelector('strong')).toBeNull();

      act(() => {
        emit?.({
          type: 'stream',
          agentId: AGENT_ID,
          channel: 'response',
          delta: 'ld** move',
          timestamp: '2026-08-07T09:00:02.000Z',
        });
      });
      expect(entry().querySelector('strong')?.textContent).toBe('bold');
    });
  });

  it('shows a response arriving progressively', async () => {
    await renderTranscript();

    act(() => {
      emit?.({
        type: 'stream',
        agentId: AGENT_ID,
        channel: 'response',
        delta: 'Here is ',
        timestamp: '2026-08-07T09:00:01.000Z',
      });
    });
    expect(entryFor('llm_response:response').textContent).toContain('Here is');

    act(() => {
      emit?.({
        type: 'stream',
        agentId: AGENT_ID,
        channel: 'response',
        delta: 'the plan',
        timestamp: '2026-08-07T09:00:02.000Z',
      });
    });

    expect(entryFor('llm_response:response').textContent).toContain(
      'Here is the plan',
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('renders a refusal as a refusal, never as a spinner', async () => {
    await renderTranscript();

    act(() => {
      fail?.(new ApiError(403, 'refused', undefined));
    });

    expect(screen.getByText(t('transcript.error.refused'))).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('has no accessibility violations', async () => {
    const { container } = await renderTranscript([
      auditEvent({ eventType: 'input', payload: { text: 'Draft a plan' } }),
      auditEvent({
        eventType: 'tool_call',
        payload: { tool: 'search', input: { query: 'pricing' } },
      }),
      auditEvent({
        eventType: 'tool_result',
        payload: { tool: 'search', output: 'two hits' },
      }),
      auditEvent({
        eventType: 'llm_response',
        payload: {
          responseText:
            '# Plan\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n[docs](https://example.com)',
        },
      }),
    ]);

    await expectNoA11yViolations(container);
  });

  describe('reasoning', () => {
    const response = (n: number) =>
      auditEvent({
        id: `audit-response-${n}`,
        eventType: 'llm_response',
        payload: {
          reasoningText: `Thought ${n}`,
          responseText: `Answer ${n}`,
        },
      });

    /** Whether each reasoning disclosure is open, in order. */
    const openStates = (): (boolean | undefined)[] =>
      screen
        .getAllByRole('listitem')
        .filter((li) => li.textContent?.includes('llm_response:reasoning'))
        .map((li) => li.querySelector('details')?.open);

    beforeEach(() => {
      localStorage.clear();
      resetReasoningRule();
    });

    it('opens only the latest by default, and re-targets when another arrives', async () => {
      await renderTranscript([response(1), response(2)]);
      expect(openStates()).toEqual([false, true]);

      act(() => {
        emit?.({
          type: 'stream',
          agentId: AGENT_ID,
          channel: 'reasoning',
          delta: 'Thought 3',
          timestamp: '2026-08-07T09:00:03.000Z',
        });
      });
      expect(openStates()).toEqual([false, false, true]);
    });

    it('opens all or none as the rule says', async () => {
      await renderTranscript([response(1), response(2)]);
      act(() => {
        setReasoningRule('all');
      });
      expect(openStates()).toEqual([true, true]);
      act(() => {
        setReasoningRule('none');
      });
      expect(openStates()).toEqual([false, false]);
    });

    it('keeps a toggled entry as the user left it until the rule changes', async () => {
      const user = userEvent.setup();
      await renderTranscript([response(1), response(2)]);
      const [first] = screen.getAllByText(/llm_response:reasoning/, {
        selector: 'summary',
      });

      await user.click(first);
      await waitFor(() => {
        expect(openStates()).toEqual([true, true]);
      });

      act(() => {
        setReasoningRule('none');
      });
      expect(openStates()).toEqual([false, false]);
    });

    it('remembers the rule', async () => {
      localStorage.setItem(REASONING_RULE_STORAGE_KEY, 'all');
      resetReasoningRule();
      await renderTranscript([response(1), response(2)]);
      expect(openStates()).toEqual([true, true]);
    });

    it('falls back to "latest" on a stored value it does not know', async () => {
      localStorage.setItem(REASONING_RULE_STORAGE_KEY, 'sideways');
      resetReasoningRule();
      await renderTranscript([response(1), response(2)]);
      expect(openStates()).toEqual([false, true]);
    });

    it('chooses the rule from a menu with the current one checked', async () => {
      const user = userEvent.setup();
      render(<ReasoningRuleMenu />);
      await user.click(
        screen.getByRole('button', { name: t('transcript.reasoning.label') }),
      );
      expect(
        screen.getByRole('menuitemradio', {
          name: t('transcript.reasoning.latest'),
        }),
      ).toHaveAttribute('aria-checked', 'true');

      await user.click(
        screen.getByRole('menuitemradio', {
          name: t('transcript.reasoning.all'),
        }),
      );
      expect(localStorage.getItem(REASONING_RULE_STORAGE_KEY)).toBe('all');
    });

    it('never announces reasoning', async () => {
      await renderTranscript();
      const before = document.querySelectorAll('[aria-live]').length;
      act(() => {
        emit?.({
          type: 'stream',
          agentId: AGENT_ID,
          channel: 'reasoning',
          delta: 'Quietly thinking',
          timestamp: '2026-08-07T09:00:03.000Z',
        });
      });
      const live = [...document.querySelectorAll('[aria-live]')];
      expect(live).toHaveLength(before);
      expect(live.some((el) => el.textContent?.includes('Quietly'))).toBe(
        false,
      );
    });
  });

  describe('follow', () => {
    /** Gives the list a layout jsdom doesn't compute, and tracks its scroll. */
    const fakeLayout = (list: HTMLElement) => {
      let top = 0;
      Object.defineProperty(list, 'scrollHeight', { value: 1000 });
      Object.defineProperty(list, 'clientHeight', { value: 100 });
      Object.defineProperty(list, 'scrollTop', {
        get: () => top,
        set: (value: number) => {
          top = value;
        },
      });
      return { top: () => top };
    };

    const followButton = () =>
      screen.getByRole('button', { name: t('transcript.follow') });

    const say = (text: string) => {
      act(() => {
        emit?.({
          type: 'stream',
          agentId: AGENT_ID,
          channel: 'response',
          delta: text,
          timestamp: '2026-08-07T09:00:05.000Z',
        });
      });
    };

    it('is on by default and keeps the newest entry in view', async () => {
      await renderTranscript([
        auditEvent({ eventType: 'input', payload: { text: 'Hello' } }),
      ]);
      const layout = fakeLayout(screen.getByRole('list'));
      expect(followButton()).toHaveAttribute('aria-pressed', 'true');

      say('Hi there');
      expect(layout.top()).toBe(1000);
    });

    it('turns off when the user scrolls away, and jumps back when turned on', async () => {
      const user = userEvent.setup();
      await renderTranscript([
        auditEvent({ eventType: 'input', payload: { text: 'Hello' } }),
      ]);
      const list = screen.getByRole('list');
      const layout = fakeLayout(list);

      list.scrollTop = 100;
      fireEvent.scroll(list);
      expect(followButton()).toHaveAttribute('aria-pressed', 'false');

      say('Hi there');
      expect(layout.top()).toBe(100);

      await user.click(followButton());
      expect(followButton()).toHaveAttribute('aria-pressed', 'true');
      expect(layout.top()).toBe(1000);
    });
  });
});
