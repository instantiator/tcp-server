import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { LlmDestinationPolicy } from '../db/llm-destination-policy';
import { ModelCompatibilityService } from './model-compatibility.service';
import * as factory from '@tcp/shared/llm/llm-factory';

// Shared mock for the BaseChatModel instance returned by buildChatModel
const mockInvoke = jest.fn();
const mockBindTools = jest.fn();
const mockWithStructuredOutput = jest.fn();

jest.spyOn(factory, 'buildChatModel').mockReturnValue({
  bindTools: mockBindTools,
  withStructuredOutput: mockWithStructuredOutput,
} as unknown as ReturnType<typeof factory.buildChatModel>);

describe('ModelCompatibilityService', () => {
  let service: ModelCompatibilityService;

  beforeEach(async () => {
    const testingModule: TestingModule = await Test.createTestingModule({
      providers: [
        ModelCompatibilityService,
        {
          provide: LlmDestinationPolicy,
          useValue: new LlmDestinationPolicy(
            new ConfigService({ LLM_ALLOWED_HOSTS: 'localhost' }),
          ),
        },
      ],
    }).compile();

    service = testingModule.get(ModelCompatibilityService);
    jest.clearAllMocks();
  });

  const lmStudioConfig = {
    provider: 'lm-studio',
    model: 'qwen3-5b',
    baseUrl: 'http://localhost:1234/v1',
    apiKey: 'LM_STUDIO_API_KEY',
  };

  it('returns compatible:true when both probes succeed', async () => {
    mockBindTools.mockReturnValue({ invoke: mockInvoke });
    mockInvoke.mockResolvedValueOnce({ tool_calls: [{ name: 'echo' }] });
    mockWithStructuredOutput.mockReturnValue({ invoke: mockInvoke });
    mockInvoke.mockResolvedValueOnce({ ok: true });

    const [result] = await service.check([lmStudioConfig]);

    expect(result.supportsTools).toBe(true);
    expect(result.supportsStructuredOutput).toBe(true);
    expect(result.compatible).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('returns supportsTools:false when tool probe returns no tool_calls', async () => {
    mockBindTools.mockReturnValue({ invoke: mockInvoke });
    mockInvoke.mockResolvedValueOnce({ tool_calls: [] });
    mockWithStructuredOutput.mockReturnValue({ invoke: mockInvoke });
    mockInvoke.mockResolvedValueOnce({ ok: true });

    const [result] = await service.check([lmStudioConfig]);

    expect(result.supportsTools).toBe(false);
    expect(result.compatible).toBe(false);
  });

  it('returns supportsTools:false when model has no bindTools method', async () => {
    // Simulate a model that does not expose bindTools
    jest.spyOn(factory, 'buildChatModel').mockReturnValueOnce({
      bindTools: undefined,
      withStructuredOutput: mockWithStructuredOutput,
    } as unknown as ReturnType<typeof factory.buildChatModel>);
    mockWithStructuredOutput.mockReturnValue({ invoke: mockInvoke });
    mockInvoke.mockResolvedValueOnce({ ok: true });

    const [result] = await service.check([lmStudioConfig]);

    expect(result.supportsTools).toBe(false);
  });

  it('reports an unclassified probe failure without its message', async () => {
    mockBindTools.mockReturnValue({ invoke: mockInvoke });
    mockInvoke.mockResolvedValueOnce({ tool_calls: [{ name: 'echo' }] });
    mockWithStructuredOutput.mockImplementation(() => {
      throw new Error('secret internal detail');
    });

    const [result] = await service.check([lmStudioConfig]);

    expect(result.supportsTools).toBe(true);
    expect(result.supportsStructuredOutput).toBe(false);
    expect(result.compatible).toBe(false);
    expect(result.errorCode).toBe('failed');
    expect(result.error).not.toContain('secret internal detail');
  });

  // A 400 means the model refused the tools or schema: it's incapable, not
  // misconfigured, so no error is reported.
  it('treats a 400 from a probe as an unsupported capability', async () => {
    mockBindTools.mockReturnValue({ invoke: mockInvoke });
    mockInvoke.mockRejectedValueOnce(
      Object.assign(new Error('tools not supported'), { status: 400 }),
    );
    mockWithStructuredOutput.mockReturnValue({ invoke: mockInvoke });
    mockInvoke.mockResolvedValueOnce({ ok: true });

    const [result] = await service.check([lmStudioConfig]);

    expect(result.supportsTools).toBe(false);
    expect(result.supportsStructuredOutput).toBe(true);
    expect(result.errorCode).toBeUndefined();
  });

  it('reports a rejected key as auth_rejected', async () => {
    const unauthorised = Object.assign(new Error('401 bad key'), {
      status: 401,
    });
    mockBindTools.mockReturnValue({ invoke: mockInvoke });
    mockWithStructuredOutput.mockReturnValue({ invoke: mockInvoke });
    mockInvoke.mockRejectedValue(unauthorised);

    const [result] = await service.check([lmStudioConfig]);

    expect(result.compatible).toBe(false);
    expect(result.errorCode).toBe('auth_rejected');
  });

  it('reports an unknown provider without building a model', async () => {
    const [result] = await service.check([{ provider: 'unknown', model: 'x' }]);

    expect(result.compatible).toBe(false);
    expect(result.errorCode).toBe('unsupported_provider');
    expect(factory.buildChatModel).not.toHaveBeenCalled();
  });

  it('refuses a destination outside the allowed hosts without calling it', async () => {
    const [result] = await service.check([
      { ...lmStudioConfig, baseUrl: 'http://169.254.169.254/v1' },
    ]);

    expect(result.errorCode).toBe('destination_refused');
    expect(result.error).toContain('LLM_ALLOWED_HOSTS');
    expect(factory.buildChatModel).not.toHaveBeenCalled();
  });

  it('processes multiple configs independently', async () => {
    mockBindTools.mockReturnValue({ invoke: mockInvoke });
    mockInvoke.mockResolvedValue({ tool_calls: [{ name: 'echo' }] });
    mockWithStructuredOutput.mockReturnValue({ invoke: mockInvoke });

    const results = await service.check([lmStudioConfig, lmStudioConfig]);

    expect(results).toHaveLength(2);
  });
});
