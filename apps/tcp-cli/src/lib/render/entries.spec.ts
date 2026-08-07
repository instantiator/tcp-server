import { LogEntry, renderEntry } from './entries';
import { plainStyle } from './style';

const at = (over: Partial<LogEntry>): LogEntry => ({
  style: 'state',
  time: '14:03:22',
  label: 'state_change:agent',
  text: 'running (resumed)',
  ...over,
});

describe('renderEntry', () => {
  it('renders a line-only entry as `time | label | text`', () => {
    expect(renderEntry(at({}), 80, plainStyle)).toEqual([
      '14:03:22 | state_change:agent | running (resumed)',
    ]);
  });

  it('renders a JSON content block with a header, blank line, and 2-space indent', () => {
    const entry = at({
      style: 'json',
      label: 'tool_call:web_search',
      text: '{\n  "tool": "web_search"\n}',
      json: true,
    });
    expect(renderEntry(entry, 80, plainStyle)).toEqual([
      '14:03:22 | tool_call:web_search |',
      '',
      '  {',
      '    "tool": "web_search"',
      '  }',
    ]);
  });

  it('word-wraps a text content block at width-2 and indents each line', () => {
    const entry = at({
      style: 'response',
      label: 'llm_response:response',
      text: 'aaaa bbbb',
    });
    // width 8 → body wraps at 6 columns.
    expect(renderEntry(entry, 8, plainStyle)).toEqual([
      '14:03:22 | llm_response:response |',
      '',
      '  aaaa',
      '  bbbb',
    ]);
  });

  it('shows the (blank) marker for an empty response block', () => {
    const entry = at({
      style: 'response',
      label: 'llm_response:response',
      text: '   ',
    });
    expect(renderEntry(entry, 80, plainStyle)).toEqual([
      '14:03:22 | llm_response:response |',
      '',
      '  (blank)',
    ]);
  });
});
