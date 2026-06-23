import { firstValueFrom, toArray, take } from 'rxjs';
import { AgentEvent, AgentEventService } from './agent-event.service';

describe('AgentEventService', () => {
  let service: AgentEventService;

  beforeEach(() => {
    service = new AgentEventService();
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('delivers emitted events to subscribers', async () => {
    const event: AgentEvent = {
      kind: 'compaction_started',
      timestamp: new Date().toISOString(),
      data: { tokensBefore: 100 },
    };

    const received$ = service.observe('agent-1').pipe(take(1));
    const resultPromise = firstValueFrom(received$);

    service.emit('agent-1', event);

    const result = await resultPromise;
    expect(result).toEqual(event);
  });

  it('delivers multiple events in order', async () => {
    const events: AgentEvent[] = [
      { kind: 'compaction_started', timestamp: 'ts1' },
      { kind: 'compaction_complete', timestamp: 'ts2' },
    ];

    const received$ = service.observe('agent-2').pipe(take(2), toArray());
    const resultPromise = firstValueFrom(received$);

    for (const e of events) service.emit('agent-2', e);

    const results = await resultPromise;
    expect(results).toEqual(events);
  });

  it('does not deliver events after cleanup', (done) => {
    let receivedCount = 0;
    const sub = service.observe('agent-3').subscribe(() => receivedCount++);

    service.emit('agent-3', { kind: 'processing_started', timestamp: 'ts' });
    service.cleanup('agent-3');
    service.emit('agent-3', { kind: 'processing_complete', timestamp: 'ts' });

    // The subject completed, so sub should be finished; give a tick to settle
    setTimeout(() => {
      sub.unsubscribe();
      expect(receivedCount).toBe(1);
      done();
    }, 10);
  });

  it('is a no-op when emitting to an agent with no subscribers', () => {
    expect(() =>
      service.emit('unknown', { kind: 'processing_started', timestamp: 'ts' }),
    ).not.toThrow();
  });

  it('cleans up all subjects on module destroy', () => {
    service.observe('a1');
    service.observe('a2');
    expect(() => service.onModuleDestroy()).not.toThrow();
  });
});
