import { refuseBaseUrl } from './base-url-policy';

const ALLOWED = ['host.docker.internal', 'stub-llm'];

describe('refuseBaseUrl', () => {
  it.each([
    ['openai', undefined],
    ['openai', 'https://api.openai.com/v1'],
    ['openai', 'https://api.openai.com/v1/'],
    [
      'amazon-bedrock',
      'https://bedrock-runtime.eu-west-2.amazonaws.com/openai/v1',
    ],
    ['azure', 'https://my-resource.openai.azure.com/openai/v1'],
    ['lm-studio', 'http://host.docker.internal:1234/v1'],
    ['openai-compatible', 'http://STUB-LLM:8080/v1'],
  ])('allows %s at %s', (provider, baseUrl) => {
    expect(refuseBaseUrl({ provider, baseUrl }, ALLOWED)).toBeUndefined();
  });

  it.each([
    ['no-such-provider', undefined, /Unknown provider/],
    ['openai', 'not a url', /not a valid URL/],
    ['openai-compatible', 'file:///etc/passwd', /http or https/],
    ['lm-studio', 'http://user:pw@stub-llm/v1', /username or password/],
    [
      'openai',
      'https://api.openai.com.evil.example/v1',
      /must use its own URL/,
    ],
    ['openai', 'https://evil.example/v1', /must use its own URL/],
    // A label placeholder must not swallow a dot and reach another domain.
    [
      'amazon-bedrock',
      'https://bedrock-runtime.evil.example/x.amazonaws.com/openai/v1',
      /must use its own URL/,
    ],
    [
      'azure',
      'https://evil.example#.openai.azure.com/openai/v1',
      /must use its own URL/,
    ],
    ['openai-compatible', 'http://169.254.169.254/v1', /not allowed/],
    ['lm-studio', 'http://localhost:1234/v1', /not allowed/],
  ])('refuses %s at %s', (provider, baseUrl, reason) => {
    expect(refuseBaseUrl({ provider, baseUrl }, ALLOWED)).toMatch(reason);
  });
});
