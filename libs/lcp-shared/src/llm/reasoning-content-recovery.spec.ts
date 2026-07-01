import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { Logger } from '@nestjs/common';
import { ReasoningContentRecovery } from './reasoning-content-recovery';

function notInvoked(): Promise<AIMessage> {
  throw new Error('invoke should not have been called');
}

function textOf(message: BaseMessage): string {
  return typeof message.content === 'string' ? message.content : '';
}

describe('ReasoningContentRecovery', () => {
  it('leaves the message unchanged when content is already present', async () => {
    const message = new AIMessage('Here is my answer.');
    const result = await ReasoningContentRecovery.recover(
      [],
      message,
      notInvoked,
    );
    expect(result.content).toBe('Here is my answer.');
  });

  it('leaves the message unchanged when tool_calls were actually made, even with blank content', async () => {
    const message = new AIMessage({
      content: '',
      tool_calls: [{ name: 'list_files', args: {}, id: 'call-1' }],
    });
    const result = await ReasoningContentRecovery.recover(
      [],
      message,
      notInvoked,
    );
    expect(result).toBe(message);
  });

  describe('when the first response is unusable (blank content, no tool_calls)', () => {
    it('re-invokes with a nudge and returns the retried response when it has content', async () => {
      const original = new AIMessage({
        content: '',
        additional_kwargs: { reasoning_content: 'Still thinking...' },
      });
      const retried = new AIMessage('The real final answer.');
      const invoke = jest.fn().mockResolvedValue(retried);

      const result = await ReasoningContentRecovery.recover(
        [new HumanMessage('question')],
        original,
        invoke,
      );

      expect(result).toBe(retried);
      expect(invoke).toHaveBeenCalledTimes(1);
      const [messages] = invoke.mock.calls[0] as [BaseMessage[]];
      expect(messages).toHaveLength(3); // original human msg + the unusable response + the nudge
      expect(messages[2]).toBeInstanceOf(HumanMessage);
    });

    it('re-invokes with a nudge and returns the retried response when it makes a real tool call', async () => {
      const original = new AIMessage({ content: '' });
      const retried = new AIMessage({
        content: '',
        tool_calls: [{ name: 'list_available_roles', args: {}, id: 'call-1' }],
      });
      const invoke = jest.fn().mockResolvedValue(retried);

      const result = await ReasoningContentRecovery.recover(
        [],
        original,
        invoke,
      );

      expect(result).toBe(retried);
    });

    it('nudges to actually invoke the tool when reasoning_content narrates an unmade <tool_call>', async () => {
      const original = new AIMessage({
        content: '',
        additional_kwargs: {
          reasoning_content:
            'I should consult the role.\n<tool_call>\n<function=interactions_request_agent_consultation>\n</function>\n</tool_call>',
        },
      });
      const invoke = jest.fn().mockResolvedValue(new AIMessage('done'));

      await ReasoningContentRecovery.recover([], original, invoke);

      const [messages] = invoke.mock.calls[0] as [BaseMessage[]];
      expect(textOf(messages.at(-1)!)).toMatch(/didn't actually invoke it/);
    });

    it('nudges to continue/finish when there is no narrated tool call', async () => {
      const original = new AIMessage({
        content: '',
        additional_kwargs: {
          reasoning_content: 'Hmm, let me think about next steps.',
        },
      });
      const invoke = jest.fn().mockResolvedValue(new AIMessage('done'));

      await ReasoningContentRecovery.recover([], original, invoke);

      const [messages] = invoke.mock.calls[0] as [BaseMessage[]];
      expect(textOf(messages.at(-1)!)).toMatch(
        /haven't provided a response yet/,
      );
    });

    it("falls back to the retried response's reasoning_content when it is also unusable", async () => {
      const original = new AIMessage({
        content: '',
        additional_kwargs: { reasoning_content: 'First attempt reasoning.' },
      });
      const retried = new AIMessage({
        content: '',
        additional_kwargs: {
          reasoning_content: 'Second attempt — the real answer.',
        },
      });
      const invoke = jest.fn().mockResolvedValue(retried);

      const result = await ReasoningContentRecovery.recover(
        [],
        original,
        invoke,
      );

      expect(result.content).toBe('Second attempt — the real answer.');
    });

    it('returns the retried response as-is when even reasoning_content is empty after the retry', async () => {
      const original = new AIMessage({ content: '' });
      const retried = new AIMessage({ content: '' });
      const invoke = jest.fn().mockResolvedValue(retried);

      const result = await ReasoningContentRecovery.recover(
        [],
        original,
        invoke,
      );

      expect(result).toBe(retried);
      expect(result.content).toBe('');
    });

    it('only invokes once, never loops indefinitely', async () => {
      const original = new AIMessage({ content: '' });
      const invoke = jest
        .fn()
        .mockResolvedValue(new AIMessage({ content: '' }));

      await ReasoningContentRecovery.recover([], original, invoke);

      expect(invoke).toHaveBeenCalledTimes(1);
    });
  });

  describe('when the last tool result is terminal (pause or task completion)', () => {
    it('returns the empty response as-is after a pause tool result', async () => {
      const pauseResult = new ToolMessage({
        content: 'Paused. Consultation request dispatched to the Cat assistant.',
        tool_call_id: 'call-1',
      });
      const empty = new AIMessage({ content: '' });

      const result = await ReasoningContentRecovery.recover(
        [new HumanMessage('question'), pauseResult],
        empty,
        notInvoked,
      );

      expect(result).toBe(empty);
    });

    it('returns the empty response as-is after a task-complete tool result', async () => {
      const completeResult = new ToolMessage({
        content: 'Task marked complete. Your run is now finished.',
        tool_call_id: 'call-2',
      });
      const empty = new AIMessage({ content: '' });

      const result = await ReasoningContentRecovery.recover(
        [new HumanMessage('question'), completeResult],
        empty,
        notInvoked,
      );

      expect(result).toBe(empty);
    });

    it('still nudges when the last tool result is non-terminal', async () => {
      const nonTerminal = new ToolMessage({
        content: 'Here are the available roles: ...',
        tool_call_id: 'call-3',
      });
      const empty = new AIMessage({ content: '' });
      const invoke = jest.fn().mockResolvedValue(new AIMessage('ok'));

      await ReasoningContentRecovery.recover(
        [new HumanMessage('question'), nonTerminal],
        empty,
        invoke,
      );

      expect(invoke).toHaveBeenCalledTimes(1);
    });
  });

  it('logs a warning naming the model when nudging', async () => {
    const logger = { warn: jest.fn() } as unknown as Logger;
    const message = new AIMessage({
      content: '',
      additional_kwargs: { reasoning_content: 'Thinking.' },
      response_metadata: { model_name: 'qwen/qwen3.5-9b' },
    });
    const invoke = jest.fn().mockResolvedValue(new AIMessage('answer'));

    await ReasoningContentRecovery.recover([], message, invoke, logger);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('qwen/qwen3.5-9b'),
    );
  });

  it('does not throw when no logger is provided', async () => {
    const message = new AIMessage({ content: '' });
    const invoke = jest.fn().mockResolvedValue(new AIMessage('answer'));
    await expect(
      ReasoningContentRecovery.recover([], message, invoke),
    ).resolves.not.toThrow();
  });
});
