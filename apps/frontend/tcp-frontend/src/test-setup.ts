import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { resetAnnouncer } from './announce/announcer';

// Testing Library auto-registers this only when the runner exposes `afterEach`
// as a global. This project imports its test API explicitly, so without this
// every render leaks into the next test as a duplicate element.
afterEach(cleanup);

// The announcer is a module singleton whose live regions live in
// `document.body`, which `cleanup()` does not touch. Without this, one test's
// announcements are in the next test's spoken phrase log — and a pending
// window fires into whichever test happens to be running when it elapses.
afterEach(resetAnnouncer);

// Every component test now renders through `AuthProvider`, which constructs the
// OIDC client, which reads the configuration nginx generates at runtime.
// Without this each of them would assert against a thrown configuration error
// instead of the page. The authority is never contacted: nothing in this tier
// gets as far as discovery. `??=`, so `user-manager.test.ts`'s own assignment —
// which is the point of that file — still wins.
window.__TCP_CONFIG__ ??= {
  oidcIssuerUrl: 'https://identity.test/',
  oidcClientId: 'tcp-web-test',
};

// jsdom does not implement matchMedia, and the theme seam reads it to seed a
// first visit. Default every query to "no preference"; a test that cares about
// a specific preference overrides this.
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  addListener: () => undefined,
  removeListener: () => undefined,
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

// Real Phaser cannot even be imported under jsdom — it runs a canvas
// feature-detection check as part of its own module initialisation, which
// throws immediately with no real `<canvas>` 2D context available
// (`Not implemented: HTMLCanvasElement's getContext()`). `CompanyPage` reaches
// it through `CompanyVisualisation`, so this is global rather than scoped to
// the visualisation suites: `App.test.tsx`, `CallbackPage.test.tsx` and
// `auth/session.test.tsx` all render the full route tree through
// `render-app.tsx` and have nothing to do with Phaser themselves — they only
// need the import not to crash. Replaces the minimal shapes
// `TcpPhaserEventBus.ts`, `TcpCompanyScene.ts` and `TcpPhaserVisualisation.tsx`
// need at import time; a suite that asserts on Phaser-specific behaviour
// (construction args, event round-trips) reads the same mocked exports back
// via `import { Game } from 'phaser'` — `vi.mock` here doesn't prevent that,
// it only replaces what the import resolves to.
vi.mock('phaser', () => {
  class MockEventEmitter {
    private readonly listeners = new Map<
      string | symbol,
      Set<(...args: unknown[]) => void>
    >();

    on(event: string | symbol, fn: (...args: unknown[]) => void) {
      const set = this.listeners.get(event) ?? new Set();
      set.add(fn);
      this.listeners.set(event, set);
      return this;
    }

    once(event: string | symbol, fn: (...args: unknown[]) => void) {
      const wrapped = (...args: unknown[]) => {
        this.off(event, wrapped);
        fn(...args);
      };
      return this.on(event, wrapped);
    }

    // No `fn` removes every listener for the event — matches eventemitter3's
    // own `off`, which every real `on(...)`/`off(...)` call site relies on.
    off(event: string | symbol, fn?: (...args: unknown[]) => void) {
      if (fn === undefined) this.listeners.delete(event);
      else this.listeners.get(event)?.delete(fn);
      return this;
    }

    emit(event: string | symbol, ...args: unknown[]) {
      const set = this.listeners.get(event);
      if (!set || set.size === 0) return false;
      for (const listener of set) listener(...args);
      return true;
    }
  }

  class MockScene {
    events = new MockEventEmitter();
  }

  interface MockGameHandle {
    config: unknown;
    destroy: ReturnType<typeof vi.fn>;
    scene: { stop: ReturnType<typeof vi.fn> };
  }

  // A real `function`, not an arrow — only a real function can be used with
  // `new`, which is how `TcpPhaserVisualisation` constructs its game. `vi.fn`
  // wrapping it is what lets a test assert on the config it was constructed
  // with, via `vi.mocked(Game)`.
  const Game = vi.fn(function (this: MockGameHandle, config: unknown) {
    this.config = config;
    this.destroy = vi.fn();
    this.scene = { stop: vi.fn() };
  });

  return {
    AUTO: 0,
    Game,
    Scene: MockScene,
    Scenes: { Events: { SHUTDOWN: 'shutdown', DESTROY: 'destroy' } },
    Events: { EventEmitter: MockEventEmitter },
  };
});
