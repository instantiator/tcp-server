import { isHostLocal, toDockerHost } from './docker-host';

describe('isHostLocal', () => {
  it.each([
    ['http://localhost:1234/v1', true],
    ['http://127.0.0.1:1234/v1', true],
    ['http://[::1]:1234/v1', true],
    ['https://api.openai.com/v1', false],
    ['http://my-lan-box:11434/v1', false],
    ['not a url', false],
  ])('%s -> %s', (url, expected) => {
    expect(isHostLocal(url)).toBe(expected);
  });
});

describe('toDockerHost', () => {
  it('rewrites localhost', () => {
    expect(toDockerHost('http://localhost:1234/v1')).toBe(
      'http://host.docker.internal:1234/v1',
    );
  });

  it('rewrites 127.0.0.1', () => {
    expect(toDockerHost('http://127.0.0.1:11434/v1')).toBe(
      'http://host.docker.internal:11434/v1',
    );
  });

  it('keeps the port', () => {
    expect(toDockerHost('http://localhost:8080')).toBe(
      'http://host.docker.internal:8080',
    );
  });

  it('keeps the path', () => {
    expect(toDockerHost('http://localhost:1234/v1/chat/completions')).toBe(
      'http://host.docker.internal:1234/v1/chat/completions',
    );
  });

  it('never adds a trailing slash that was not there', () => {
    expect(toDockerHost('http://localhost:1234')).toBe(
      'http://host.docker.internal:1234',
    );
  });

  it('leaves a non-local URL unchanged', () => {
    expect(toDockerHost('https://api.openai.com/v1')).toBe(
      'https://api.openai.com/v1',
    );
  });
});
