import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { SystemShutdownService } from './system-shutdown.service';

describe('SystemShutdownService', () => {
  let service: SystemShutdownService;

  beforeEach(() => {
    service = new SystemShutdownService();
  });

  describe('state transitions', () => {
    it('starts idle and accepting work', () => {
      expect(service.currentState).toBe('idle');
      expect(service.isShuttingDown).toBe(false);
      expect(service.isForced).toBe(false);
    });

    it('moves idle → draining → quiesced', () => {
      expect(service.begin(false)).toBe(true);
      expect(service.currentState).toBe('draining');

      expect(service.markQuiesced()).toBe(true);
      expect(service.currentState).toBe('quiesced');
    });

    it('treats a repeated graceful drain as a no-op', () => {
      service.begin(false);
      expect(service.begin(false)).toBe(false);
      expect(service.currentState).toBe('draining');
    });

    it('upgrades an in-progress graceful drain to forced', () => {
      service.begin(false);
      expect(service.begin(true)).toBe(true);
      expect(service.isForced).toBe(true);
      expect(service.currentState).toBe('draining');
    });

    it('never downgrades a forced drain back to graceful', () => {
      service.begin(true);
      expect(service.begin(false)).toBe(false);
      expect(service.isForced).toBe(true);
    });

    it('ignores markQuiesced unless a drain is in progress', () => {
      expect(service.markQuiesced()).toBe(false);
      expect(service.currentState).toBe('idle');

      service.begin(false);
      service.markQuiesced();
      // Already quiesced — a second call changes nothing.
      expect(service.markQuiesced()).toBe(false);
      expect(service.currentState).toBe('quiesced');
    });

    it('cancels a drain back to idle, clearing the forced flag', () => {
      service.begin(true);
      expect(service.cancel()).toBe(true);
      expect(service.currentState).toBe('idle');
      expect(service.isForced).toBe(false);
    });

    it('cancels from quiesced too', () => {
      service.begin(false);
      service.markQuiesced();
      expect(service.cancel()).toBe(true);
      expect(service.currentState).toBe('idle');
    });

    it('reports nothing to cancel when idle', () => {
      expect(service.cancel()).toBe(false);
    });
  });

  describe('restart', () => {
    it('records that the drain ends in a restart, and clears it on cancel', () => {
      service.begin(false, true);
      expect(service.isRestarting).toBe(true);
      service.cancel();
      expect(service.isRestarting).toBe(false);
    });

    it('refuses to switch a shutdown in progress to a restart, or back', () => {
      service.begin(false);
      expect(() => service.begin(false, true)).toThrow(ConflictException);
      service.cancel();
      service.begin(false, true);
      expect(() => service.begin(true)).toThrow(ConflictException);
    });

    it('still lets force escalate a restart drain', () => {
      service.begin(false, true);
      expect(service.begin(true, true)).toBe(true);
      expect(service.isForced).toBe(true);
    });

    it('says a restart, not a shutdown, when refusing work', () => {
      service.begin(false, true);
      expect(() => service.assertAccepting()).toThrow(/restarting/);
    });
  });

  describe('assertAccepting', () => {
    it('permits work while idle', () => {
      expect(() => service.assertAccepting()).not.toThrow();
    });

    it('refuses work while draining', () => {
      service.begin(false);
      expect(() => service.assertAccepting()).toThrow(
        ServiceUnavailableException,
      );
    });

    it('still refuses work once quiesced — the system is waiting to halt', () => {
      service.begin(false);
      service.markQuiesced();
      expect(() => service.assertAccepting()).toThrow(
        ServiceUnavailableException,
      );
    });

    it('permits work again after a cancel', () => {
      service.begin(false);
      service.cancel();
      expect(() => service.assertAccepting()).not.toThrow();
    });
  });
});
