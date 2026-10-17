import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { LlmConfig } from '@tcp/shared/client';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { t } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import {
  fetchMock,
  installFetchMock,
  respondByRoute,
} from '../../test-support/fetch-mock';
import { LlmConfigPicker, type LlmFallback } from './LlmConfigPicker';
import { draftOf, type LlmDraft, type LlmPurpose } from './llmDraft';

const COMPANY_FALLBACK: LlmFallback = {
  from: 'company',
  config: { provider: 'lm-studio', model: 'gemma' },
};

/** Holds the draft, as a host form would, and shows it for assertions. */
const Host = ({
  saved = null,
  purpose = 'chat',
  fallback = COMPANY_FALLBACK,
  footprint,
  onDraft,
  creating = false,
}: {
  /** No company exists yet, as in the create dialog. */
  creating?: boolean;
  saved?: LlmConfig | null;
  purpose?: LlmPurpose;
  fallback?: LlmFallback;
  footprint?: number | 'unsaved';
  onDraft?: (draft: LlmDraft) => void;
}) => {
  const [draft, setDraft] = useState(() => draftOf(saved));
  return (
    <LlmConfigPicker
      purpose={purpose}
      draft={draft}
      onChange={(next) => {
        setDraft(next);
        onDraft?.(next);
      }}
      saved={saved}
      fallback={fallback}
      companyId={creating ? undefined : 'c1'}
      footprint={footprint}
      embeddingDimension={768}
      errors={{}}
    />
  );
};

const render_ = (props: Parameters<typeof Host>[0] = {}) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <Host {...props} />
    </QueryClientProvider>,
  );

/** Opens the provider list and picks `name`. */
const chooseProvider = async (
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) => {
  await user.click(screen.getByRole('button', { name: /Provider/ }));
  await user.click(await screen.findByRole('option', { name }));
};

describe('LlmConfigPicker', () => {
  beforeEach(() => {
    installFetchMock();
    respondByRoute([
      [/\/llm\/models$/, { body: { models: ['google/gemma-4-e4b', 'mine'] } }],
    ]);
  });

  it('names what inheriting falls back to', () => {
    render_();
    expect(
      screen.getByRole('button', {
        name: new RegExp(
          t('llm.inherit.company', {
            provider: 'LM Studio',
            model: 'gemma',
          }).replace(/[()]/g, '.'),
        ),
      }),
    ).toBeVisible();
  });

  it('warns when nothing is left to fall back to', () => {
    render_({ fallback: { from: 'app', config: null } });
    expect(screen.getByText(t('llm.inherit.noneHint'))).toBeVisible();
  });

  it('fills the starter model and address on choosing a provider, and lists its models', async () => {
    const user = userEvent.setup();
    render_();
    await chooseProvider(user, 'LM Studio');

    expect(screen.getByRole('combobox', { name: /Model/ })).toHaveValue(
      'google/gemma-4-e4b',
    );
    expect(screen.getByRole('textbox', { name: /Address/ })).toHaveValue(
      'http://localhost:1234/v1',
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([r]) => r instanceof Request && r.url.endsWith('/llm/models'),
        ),
      ).toBe(true),
    );

    await user.click(screen.getByRole('combobox', { name: /Model/ }));
    const options = await screen.findAllByRole('option');
    const names = options.map((o) => o.textContent ?? '');
    expect(
      names.filter((n) => n.startsWith('google/gemma-4-e4b')),
    ).toHaveLength(1);
    expect(names.some((n) => n.startsWith('mine'))).toBe(true);
  });

  it('lists nothing while the company is being created, and says when it can', async () => {
    const user = userEvent.setup();
    render_({ creating: true });
    await chooseProvider(user, 'LM Studio');

    expect(screen.getByText(t('llm.model.listAfterCreate'))).toBeVisible();
    expect(
      screen.queryByRole('button', { name: t('llm.model.refresh') }),
    ).toBeNull();
    // Suggestions are still offered.
    await user.click(screen.getByRole('combobox', { name: /Model/ }));
    expect((await screen.findAllByRole('option')).length).toBeGreaterThan(0);
    expect(
      fetchMock.mock.calls.some(
        ([r]) => r instanceof Request && r.url.endsWith('/llm/models'),
      ),
    ).toBe(false);
  });

  it('shows a remote provider’s address rather than letting it be edited, and builds it from the region', async () => {
    const user = userEvent.setup();
    render_();
    await chooseProvider(user, 'Amazon Bedrock');

    expect(screen.queryByRole('textbox', { name: /Address/ })).toBeNull();
    await user.type(
      screen.getByRole('textbox', { name: /Region/ }),
      'eu-west-2',
    );
    expect(
      screen.getByText(
        t('llm.baseUrl.fixed', {
          url: 'https://bedrock-runtime.eu-west-2.amazonaws.com/openai/v1',
        }),
      ),
    ).toBeVisible();
    // Remote models aren't listed live.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('offers only providers with an embedding model, for embeddings', async () => {
    const user = userEvent.setup();
    render_({ purpose: 'embedding' });
    await user.click(screen.getByRole('button', { name: /Provider/ }));
    expect(
      await screen.findByRole('option', { name: 'Mistral' }),
    ).toBeVisible();
    expect(screen.queryByRole('option', { name: 'Anthropic' })).toBeNull();
  });

  it('says a saved key is kept, and dropped when the address changes', async () => {
    const user = userEvent.setup();
    render_({
      saved: {
        provider: 'lm-studio',
        model: 'm',
        baseUrl: 'http://host.docker.internal:1234/v1',
        apiKey: '***',
      },
    });
    const key = screen.getByLabelText(/API key/);
    expect(key).toHaveValue('');
    expect(key).toHaveAttribute('type', 'password');
    expect(screen.getByText(t('llm.apiKey.saved'))).toBeVisible();

    const address = screen.getByRole('textbox', { name: /Address/ });
    await user.clear(address);
    await user.type(address, 'http://gpu-box.lan:1234/v1');
    expect(screen.getByText(t('llm.apiKey.dropped'))).toBeVisible();
  });

  it('shows a listing failure as a hint, not an error', async () => {
    respondByRoute([
      [
        /\/llm\/models$/,
        { status: 502, body: { message: 'Couldn’t reach it.' } },
      ],
    ]);
    render_({
      saved: {
        provider: 'lm-studio',
        model: 'm',
        baseUrl: 'http://localhost:1234/v1',
      },
    });
    expect(
      await screen.findByText(
        t('llm.model.listFailed', { reason: 'Couldn’t reach it.' }),
      ),
    ).toBeVisible();
  });

  it('gives the context window as a budget against the tools', () => {
    render_({
      saved: { provider: 'openai', model: 'gpt-5-mini', contextWindow: 8192 },
      footprint: 5800,
    });
    expect(
      screen.getByText(
        new RegExp(
          t('llm.contextWindow.budget', { tools: '5,800', left: '2,392' }),
        ),
      ),
    ).toBeVisible();
  });

  it('has no accessibility violations, inheriting or configured', async () => {
    const { container, unmount } = render_();
    await expectNoA11yViolations(container);
    unmount();
    const configured = render_({
      saved: { provider: 'lm-studio', model: 'm', baseUrl: 'http://x:1/v1' },
    });
    await expectNoA11yViolations(configured.container);
  });
});
