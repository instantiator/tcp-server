import { ConfigService } from '@nestjs/config';
import type { ModelConcurrencyLimits } from './model-concurrency';
import { ModelSlotService } from './model-slot.service';

/** A slot service with no MODEL_CONCURRENCY set; tests pass limits directly. */
function slots(): ModelSlotService {
  return new ModelSlotService(new ConfigService({}));
}

/** Limits for a run on `endpointKey` in `pool`. */
function limits(
  pool: 'local' | 'remote',
  poolLimit: number | null,
  endpointKey: string,
  endpointLimit: number | null = null,
): ModelConcurrencyLimits {
  return { pool, poolLimit, endpointKey, endpointLimit };
}

describe('ModelSlotService', () => {
  it('admits runs up to the pool limit, then refuses', () => {
    const s = slots();
    const lm = limits('local', 2, 'http://a');
    expect(s.tryAcquire(lm, 'j1')).not.toBeNull();
    expect(s.tryAcquire(lm, 'j2')).not.toBeNull();
    expect(s.tryAcquire(lm, 'j3')).toBeNull();
  });

  it('refuses on a full pool even when the endpoint has room', () => {
    const s = slots();
    s.tryAcquire(limits('local', 1, 'http://a', 5), 'j1');
    expect(s.tryAcquire(limits('local', 1, 'http://b', 5), 'j2')).toBeNull();
  });

  it('refuses on a full endpoint even when the pool has room', () => {
    const s = slots();
    s.tryAcquire(limits('remote', 4, 'anthropic', 1), 'j1');
    expect(s.tryAcquire(limits('remote', 4, 'anthropic', 1), 'j2')).toBeNull();
    expect(s.tryAcquire(limits('remote', 4, 'openai'), 'j3')).not.toBeNull();
  });

  it('takes neither slot when it refuses', () => {
    const s = slots();
    // The endpoint is full, so the pool slot must not be taken either…
    s.tryAcquire(limits('remote', 2, 'anthropic', 1), 'j1');
    expect(s.tryAcquire(limits('remote', 2, 'anthropic', 1), 'j2')).toBeNull();
    // …leaving the pool's second slot for a run elsewhere.
    expect(s.tryAcquire(limits('remote', 2, 'openai'), 'j3')).not.toBeNull();
  });

  it('keeps the local and remote pools apart', () => {
    const s = slots();
    s.tryAcquire(limits('local', 1, 'http://a'), 'j1');
    expect(s.tryAcquire(limits('remote', 1, 'openai'), 'j2')).not.toBeNull();
  });

  it('never refuses an unlimited pool with no endpoint limit', () => {
    const s = slots();
    for (let i = 0; i < 50; i++) {
      expect(
        s.tryAcquire(limits('remote', null, 'openai'), `j${i}`),
      ).not.toBeNull();
    }
  });

  it('frees the slot on release, once only', () => {
    const s = slots();
    const lm = limits('local', 1, 'http://a');
    const lease = s.tryAcquire(lm, 'j1');
    lease?.release();
    lease?.release(); // a second release must not free a slot it doesn't hold
    expect(s.tryAcquire(lm, 'j2')).not.toBeNull();
    expect(s.tryAcquire(lm, 'j3')).toBeNull();
  });

  it('names the oldest waiting job that fits on release', () => {
    const s = slots();
    const lm = limits('local', 1, 'http://a');
    const lease = s.tryAcquire(lm, 'j1');
    s.tryAcquire(lm, 'j2');
    s.tryAcquire(lm, 'j3');
    s.tryAcquire(lm, 'j2'); // a re-check doesn't lose j2 its place
    expect(lease?.release()).toBe('j2');
  });

  it('skips a waiter whose endpoint is still full', () => {
    const s = slots();
    s.tryAcquire(limits('remote', 2, 'anthropic', 1), 'j1');
    const openai = s.tryAcquire(limits('remote', 2, 'openai'), 'j2'); // pool now full
    s.tryAcquire(limits('remote', 2, 'anthropic', 1), 'j3'); // waits: pool and endpoint full
    s.tryAcquire(limits('remote', 2, 'openai'), 'j4'); // waits: pool full
    // Freeing j2's pool slot can't help j3 (anthropic is still held), so j4 goes.
    expect(openai?.release()).toBe('j4');
  });

  it('names no waiter from the other pool', () => {
    const s = slots();
    const local = s.tryAcquire(limits('local', 1, 'http://a'), 'j1');
    s.tryAcquire(limits('remote', 1, 'openai'), 'j2');
    s.tryAcquire(limits('remote', 1, 'openai'), 'j3'); // waits on the remote pool
    expect(local?.release()).toBeUndefined();
  });

  it('forgets a waiter once it acquires', () => {
    const s = slots();
    const lm = limits('local', 1, 'http://a');
    const first = s.tryAcquire(lm, 'j1');
    s.tryAcquire(lm, 'j2');
    first?.release();
    const second = s.tryAcquire(lm, 'j2'); // j2 got in by its own timer
    expect(second?.release()).toBeUndefined();
  });

  it('lets a run with an unknown provider through unlimited', () => {
    expect(
      slots().limitsFor({ provider: 'no-such-provider', model: 'm' }),
    ).toBeUndefined();
  });
});
