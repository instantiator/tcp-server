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

  it('round-trips oidcLoadUserInfo as true', () => {
    window.__TCP_CONFIG__ = {
      oidcIssuerUrl: 'https://idp.example.com',
      oidcClientId: 'tcp-web',
      oidcLoadUserInfo: true,
    };

    expect(getRuntimeConfig()).toEqual({
      oidcIssuerUrl: 'https://idp.example.com',
      oidcClientId: 'tcp-web',
      oidcLoadUserInfo: true,
    });
  });

  it('round-trips oidcLoadUserInfo as false', () => {
    window.__TCP_CONFIG__ = {
      oidcIssuerUrl: 'https://idp.example.com',
      oidcClientId: 'tcp-web',
      oidcLoadUserInfo: false,
    };

    expect(getRuntimeConfig()).toEqual({
      oidcIssuerUrl: 'https://idp.example.com',
      oidcClientId: 'tcp-web',
      oidcLoadUserInfo: false,
    });
  });

  it('does not throw when oidcLoadUserInfo is absent', () => {
    window.__TCP_CONFIG__ = {
      oidcIssuerUrl: 'https://idp.example.com',
      oidcClientId: 'tcp-web',
    };

    expect(() => getRuntimeConfig()).not.toThrow();
  });

  it('keeps a valid http(s) storageConsoleUrl', () => {
    window.__TCP_CONFIG__ = {
      oidcIssuerUrl: 'https://idp.example.com',
      oidcClientId: 'tcp-web',
      storageConsoleUrl: 'https://minio.example.com:9001',
      storageBucket: 'tcp',
    };

    expect(getRuntimeConfig().storageConsoleUrl).toBe(
      'https://minio.example.com:9001',
    );
  });

  it('drops a javascript: storageConsoleUrl rather than trusting it into an href', () => {
    window.__TCP_CONFIG__ = {
      oidcIssuerUrl: 'https://idp.example.com',
      oidcClientId: 'tcp-web',
      storageConsoleUrl: "javascript:alert('x')",
      storageBucket: 'tcp',
    };

    expect(getRuntimeConfig().storageConsoleUrl).toBeUndefined();
  });

  it('drops a storageConsoleUrl that is not a parseable URL', () => {
    window.__TCP_CONFIG__ = {
      oidcIssuerUrl: 'https://idp.example.com',
      oidcClientId: 'tcp-web',
      storageConsoleUrl: 'not a url',
    };

    expect(getRuntimeConfig().storageConsoleUrl).toBeUndefined();
  });

  it('leaves storageConsoleUrl undefined when absent', () => {
    window.__TCP_CONFIG__ = {
      oidcIssuerUrl: 'https://idp.example.com',
      oidcClientId: 'tcp-web',
    };

    expect(getRuntimeConfig().storageConsoleUrl).toBeUndefined();
  });
});
