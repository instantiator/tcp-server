import { afterEach, describe, expect, it } from 'vitest';
import { getRuntimeConfig } from './runtime-config';

describe('getRuntimeConfig', () => {
  afterEach(() => {
    // Each case sets its own shape of window.__TCP_CONFIG__ (or none); leaving
    // it behind would let one test's global leak into the next.
    delete window.__TCP_CONFIG__;
  });

  it('returns both values when the global is present and well-formed', () => {
    window.__TCP_CONFIG__ = {
      oidcIssuerUrl: 'https://idp.example.com',
      oidcClientId: 'tcp-web',
    };

    expect(getRuntimeConfig()).toEqual({
      oidcIssuerUrl: 'https://idp.example.com',
      oidcClientId: 'tcp-web',
    });
  });

  it('throws mentioning config.js when the global is absent', () => {
    expect(() => getRuntimeConfig()).toThrow(/config\.js/);
  });

  it('throws when oidcIssuerUrl is empty', () => {
    window.__TCP_CONFIG__ = { oidcIssuerUrl: '', oidcClientId: 'tcp-web' };

    expect(() => getRuntimeConfig()).toThrow();
  });

  it('throws when oidcClientId is empty', () => {
    window.__TCP_CONFIG__ = {
      oidcIssuerUrl: 'https://idp.example.com',
      oidcClientId: '',
    };

    expect(() => getRuntimeConfig()).toThrow();
  });
});
