import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';

// Testing Library auto-registers this only when the runner exposes `afterEach`
// as a global. This project imports its test API explicitly, so without this
// every render leaks into the next test as a duplicate element.
afterEach(cleanup);

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
