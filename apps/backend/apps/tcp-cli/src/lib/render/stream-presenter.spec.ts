import { AuditWireEvent, StreamDelta, EventLogBuffer } from '@tcp/shared';
import { plainStyle } from './style';
import { StreamPresenter } from './stream-presenter';

/** A writable that accumulates everything written to it. */
function sink(): NodeJS.WritableStream & { text: () => string } {
  const chunks: string[] = [];
  const stream = {
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    text: () => chunks.join(''),
  };
  return stream as unknown as NodeJS.WritableStream & { text: () => string };
}

function audit(
  eventType: string,
  payload: Record<string, unknown>,
): AuditWireEvent {
  return {
    timestamp: '2026-07-19T14:03:22.000Z',
    companyId: 'c',
    role: 'r',
    agentId: 'ag',
    assignmentId: null,
    taskId: null,
    eventType: eventType as AuditWireEvent['eventType'],
    payload,
  };
}

const TS = '2026-07-19T14:03:22.000Z';
/** The event timestamp as local hh:mm:ss — matches `parseClockTime`, TZ-independent. */
const HH = new Date(TS).toTimeString().slice(0, 8);

const delta = (channel: 'reasoning' | 'response', d: string): StreamDelta => ({
  type: 'stream',
  agentId: 'ag',
  channel,
  delta: d,
  timestamp: TS,
});

describe('StreamPresenter', () => {
  it('routes response content to out and everything else to err', () => {
    const out = sink();
    const err = sink();
    const buf = new EventLogBuffer(() => ({}));
    new StreamPresenter(buf, { out, err, style: plainStyle, width: 80 });

    buf.appendAudit(audit('state_change', { newStatus: 'running' }));
    buf.appendDelta(delta('response', 'Hello'));
    buf.appendAudit(audit('state_change', { newStatus: 'idle' }));

    expect(out.text()).toContain('Hello');
    expect(err.text()).toContain('running');
    expect(err.text()).not.toContain('Hello');
  });

  it('streams deltas inline under a header, closing the block on the next event', () => {
    const out = sink();
    const err = sink();
    const buf = new EventLogBuffer(() => ({}));
    new StreamPresenter(buf, { out, err, style: plainStyle, width: 80 });

    buf.appendDelta(delta('response', 'Hel'));
    buf.appendDelta(delta('response', 'lo'));
    buf.appendAudit(audit('state_change', { newStatus: 'idle' }));

    expect(out.text()).toBe(`${HH} | llm_response:response |\nHello\n`);
  });

  it('writes the (blank) marker for an empty response block', () => {
    const out = sink();
    const err = sink();
    const buf = new EventLogBuffer(() => ({}));
    new StreamPresenter(buf, { out, err, style: plainStyle, width: 80 });

    buf.appendDelta(delta('response', '   '));
    buf.appendAudit(audit('state_change', { newStatus: 'idle' }));

    expect(out.text()).toContain('(blank)');
  });
});
