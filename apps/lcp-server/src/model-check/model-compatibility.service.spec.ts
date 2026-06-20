import { Test, TestingModule } from '@nestjs/testing';
import { ModelCompatibilityService } from './model-compatibility.service';
import * as factory from './llm-factory';

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
      providers: [ModelCompatibilityService],
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

  it('returns supportsStructuredOutput:false when the probe throws', async () => {
    mockBindTools.mockReturnValue({ invoke: mockInvoke });
    mockInvoke.mockResolvedValueOnce({ tool_calls: [{ name: 'echo' }] });
    mockWithStructuredOutput.mockImplementation(() => {
      throw new Error('not supported');
    });

    const [result] = await service.check([lmStudioConfig]);

    expect(result.supportsStructuredOutput).toBe(false);
    expect(result.compatible).toBe(false);
  });

  it('sets error and returns compatible:false when buildChatModel throws', async () => {
    jest.spyOn(factory, 'buildChatModel').mockImplementationOnce(() => {
      throw new Error('Unsupported LLM provider: unknown');
    });

    const [result] = await service.check([{ provider: 'unknown', model: 'x' }]);

    expect(result.compatible).toBe(false);
    expect(result.error).toContain('Unsupported LLM provider');
  });

  it('processes multiple configs independently', async () => {
    mockBindTools.mockReturnValue({ invoke: mockInvoke });
    mockInvoke.mockResolvedValue({ tool_calls: [{ name: 'echo' }] });
    mockWithStructuredOutput.mockReturnValue({ invoke: mockInvoke });

    const results = await service.check([lmStudioConfig, lmStudioConfig]);

    expect(results).toHaveLength(2);
  });
});
