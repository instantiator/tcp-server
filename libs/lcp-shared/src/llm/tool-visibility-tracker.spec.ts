import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { ToolVisibilityTracker } from './tool-visibility-tracker';

function makeTool(name: string): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name,
    description: 'test tool',
    schema: z.object({}),
    func: () => Promise.resolve(''),
  });
}

const ALL_TOOLS = [
  makeTool('storage__describe_server'),
  makeTool('storage__read_file'),
  makeTool('storage__append_working_file'),
  makeTool('memory__describe_server'),
  makeTool('memory__recall'),
  makeTool('interactions__describe_server'),
  makeTool('interactions__complete_task'),
  makeTool('interactions__request_user_input'),
];

function names(tools: DynamicStructuredTool[]): string[] {
  return tools.map((t) => t.name);
}

function toolEndEvent(toolName: string) {
  return { event: 'on_tool_end', name: toolName };
}

function chatModelStartEvent() {
  return { event: 'on_chat_model_start' };
}

describe('ToolVisibilityTracker', () => {
  it('initially shows only describe_server tools, plus always-visible servers in full', () => {
    const tracker = new ToolVisibilityTracker();
    const visible = names(tracker.resolveVisibleTools(ALL_TOOLS));

    expect(visible).toEqual(
      expect.arrayContaining([
        'storage__describe_server',
        'memory__describe_server',
        'interactions__describe_server',
        'interactions__complete_task',
        'interactions__request_user_input',
      ]),
    );
    expect(visible).not.toContain('storage__read_file');
    expect(visible).not.toContain('storage__append_working_file');
    expect(visible).not.toContain('memory__recall');
  });

  it("reveals a server's other tools after its describe_server tool is called", () => {
    const tracker = new ToolVisibilityTracker();
    tracker.onEvent(toolEndEvent('storage__describe_server'));

    const visible = names(tracker.resolveVisibleTools(ALL_TOOLS));

    expect(visible).toContain('storage__read_file');
    expect(visible).toContain('storage__append_working_file');
    // memory was never described — still gated
    expect(visible).not.toContain('memory__recall');
  });

  it('decrements the TTL once per on_chat_model_start and re-gates the server once exhausted', () => {
    const tracker = new ToolVisibilityTracker(new Set(['interactions']), 3);
    tracker.onEvent(toolEndEvent('storage__describe_server'));

    // 3 iterations of visibility remain after describing.
    tracker.onEvent(chatModelStartEvent());
    expect(names(tracker.resolveVisibleTools(ALL_TOOLS))).toContain(
      'storage__read_file',
    );

    tracker.onEvent(chatModelStartEvent());
    expect(names(tracker.resolveVisibleTools(ALL_TOOLS))).toContain(
      'storage__read_file',
    );

    tracker.onEvent(chatModelStartEvent());
    // Third decrement exhausts the TTL — gated again.
    expect(names(tracker.resolveVisibleTools(ALL_TOOLS))).not.toContain(
      'storage__read_file',
    );
  });

  it('re-describing resets the TTL back to full', () => {
    const tracker = new ToolVisibilityTracker(new Set(['interactions']), 3);
    tracker.onEvent(toolEndEvent('storage__describe_server'));
    tracker.onEvent(chatModelStartEvent());
    tracker.onEvent(chatModelStartEvent());
    tracker.onEvent(chatModelStartEvent());
    expect(names(tracker.resolveVisibleTools(ALL_TOOLS))).not.toContain(
      'storage__read_file',
    );

    tracker.onEvent(toolEndEvent('storage__describe_server'));
    expect(names(tracker.resolveVisibleTools(ALL_TOOLS))).toContain(
      'storage__read_file',
    );
  });

  it('always shows the entire tool set of an always-visible server, describe_server call or not', () => {
    const tracker = new ToolVisibilityTracker();
    const visible = names(tracker.resolveVisibleTools(ALL_TOOLS));

    expect(visible).toContain('interactions__complete_task');
    expect(visible).toContain('interactions__request_user_input');
  });

  it('ignores non-describe_server tool_end events', () => {
    const tracker = new ToolVisibilityTracker();
    tracker.onEvent(toolEndEvent('storage__read_file'));

    expect(names(tracker.resolveVisibleTools(ALL_TOOLS))).not.toContain(
      'storage__read_file',
    );
  });

  it('supports a custom always-visible server set and TTL', () => {
    const tracker = new ToolVisibilityTracker(new Set(['memory']), 1);
    const visible = names(tracker.resolveVisibleTools(ALL_TOOLS));
    expect(visible).toContain('memory__recall');
    // interactions is no longer exempt with this custom set
    expect(visible).not.toContain('interactions__complete_task');
  });
});
