import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
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
