// A consultation, followed from the asking agent's web transcript (002.07):
// a person chats with one role, which consults another; the transcript shows
// the question, then the answer, and links to the consulted conversation.
//
// Needs the stub LLM to be scripted from here, so the stack must publish its
// port (`--dev-ports`) and run it (`STUB_LLM=true`); the spec skips with that
// reason when it can't reach it. Fixtures use the machine token, as
// `add-new.spec.ts` does (no shared helper module between browser specs).
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { AUTH_STATE_PATH, hasSignInCredentials } from './auth-state';
import { gotoSignedIn } from './signed-in';

const OIDC_DISCOVERY_URL =
  process.env.OIDC_DISCOVERY_URL ??
  'http://localhost:8080/.well-known/openid-configuration';
const TEST_CLIENT_ID = process.env.TEST_CLIENT_ID ?? '';
const TEST_CLIENT_SECRET = process.env.TEST_CLIENT_SECRET ?? '';
const hasMachineCredentials = Boolean(TEST_CLIENT_ID && TEST_CLIENT_SECRET);

/** Where the test reaches the stub LLM (published by `--dev-ports`). */
const STUB_URL = process.env.STUB_LLM_PUBLISHED_URL ?? 'http://localhost:3002';
/** Where the stack's own services reach it, on the compose network. */
const STUB_BASE_URL = 'http://stub-llm:3002/v1';

/*
 * Literals copied from `src/strings.ts` by hand, as the other browser specs do:
 * `addNew.*`, `chat.*` and `transcript.consultation.*`.
 */
const ADD_NEW_TRIGGER = 'Add new';
const NEW_CHAT_ITEM = 'New chat';
const SEND_LABEL = 'Send';
const asked = (role: string): string => `Asked ${role}`;
const answered = (role: string): string => `${role} answered`;
const working = (role: string): string => `${role} is working on it…`;
const openConversation = (role: string): string =>
  `Open conversation with ${role}`;
const chatWithRole = (role: string): string => `Chat with ${role}`;
const messageLabel = (role: string): string => `Message ${role}`;

interface StubConfig {
  prompts?: unknown[];
  defaults?: unknown;
}

const getMachineToken = async (request: APIRequestContext): Promise<string> => {
  const discovery = await request.get(OIDC_DISCOVERY_URL);
  expect(discovery.ok()).toBe(true);
  const { token_endpoint } = (await discovery.json()) as {
    token_endpoint: string;
  };
  const tokenRes = await request.post(token_endpoint, {
    form: {
      grant_type: 'client_credentials',
      client_id: TEST_CLIENT_ID,
      client_secret: TEST_CLIENT_SECRET,
      scope: 'openid profile',
    },
  });
  expect(tokenRes.ok()).toBe(true);
  return ((await tokenRes.json()) as { access_token: string }).access_token;
};

test.use({
  storageState: hasSignInCredentials ? AUTH_STATE_PATH : undefined,
});

test.skip(
  !hasSignInCredentials || !hasMachineCredentials,
  'Requires TEST_USERNAME/TEST_PASSWORD and TEST_CLIENT_ID/TEST_CLIENT_SECRET ' +
    '— see scripts/run-browser-tests.sh.',
);

test.describe('a consultation', () => {
  const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  // Rules match the whole prompt, so each marker must occur only where meant.
  const askMarker = `ASK-${unique}`;
  const questionMarker = `QUESTION-${unique}`;
  const answer = `The answer is ${unique}.`;
  const askerName = `Asker ${unique}`;
  const consultedName = `Oracle ${unique}`;
  const consultedSlug = `oracle-${unique}`;

  let token: string;
  let companyId: string;
  let previousStubConfig: StubConfig;

  const putStubConfig = async (
    request: APIRequestContext,
    config: StubConfig,
  ): Promise<void> => {
    const res = await request.put(`${STUB_URL}/stub/config`, { data: config });
    expect(res.ok()).toBe(true);
  };

  test.beforeAll(async ({ request }) => {
    const health = await request
      .get(`${STUB_URL}/health`)
      .catch(() => undefined);
    test.skip(
      !health?.ok(),
      `The stub LLM is not reachable at ${STUB_URL}: start the stack with ` +
        'STUB_LLM=true and --dev-ports (see scripts/run-browser-tests.sh).',
    );

    // PUT replaces the whole config, so keep the current one to put back.
    previousStubConfig = (await (
      await request.get(`${STUB_URL}/stub/config`)
    ).json()) as StubConfig;

    await putStubConfig(request, {
      prompts: [
        {
          // Only a caller resumed with the answer; its history still holds the
          // opening marker, so this rule must come first.
          match: 'Consultation response',
          mode: 'loop',
          responses: [{ text: 'The oracle has answered.' }],
        },
        {
          match: questionMarker,
          mode: 'loop',
          responses: [
            {
              text: 'Answering the asker.',
              tools: [
                {
                  tool: 'tasks__complete_assignment',
                  data: { summary: answer, prepared: [] },
                },
              ],
            },
          ],
        },
        {
          match: askMarker,
          mode: 'loop',
          responses: [
            {
              text: 'I will ask the oracle.',
              tools: [
                {
                  tool: 'interactions__request_agent_consultation',
                  data: {
                    roleSlug: consultedSlug,
                    question: `${questionMarker} what is the answer?`,
                  },
                },
              ],
            },
          ],
        },
      ],
      defaults: {
        mode: 'loop',
        responses: [{ text: 'stub-llm fallback: no rule matched this prompt' }],
      },
    });

    token = await getMachineToken(request);
    const headers = { Authorization: `Bearer ${token}` };
    const company = await request.post('/api/company', {
      headers,
      data: {
        name: `consultation ${unique}`,
        slug: `consultation-${unique}`,
        description: 'Created by consultation.spec.ts',
        llmConfig: {
          provider: 'openai-compatible',
          model: 'stub',
          baseUrl: STUB_BASE_URL,
          // The default window is smaller than the tool schemas alone.
          contextWindow: 32_000,
        },
      },
    });
    expect(company.status()).toBe(201);
    companyId = ((await company.json()) as { id: string }).id;

    for (const [slug, name] of [
      [`asker-${unique}`, askerName],
      [consultedSlug, consultedName],
    ]) {
      const role = await request.post('/api/role', {
        headers,
        data: {
          companyId,
          slug,
          name,
          description: 'Created by consultation.spec.ts',
          knowledgeDomains: [],
          mcpServerList: [],
        },
      });
      expect(role.status()).toBe(201);
    }
  });

  test.afterAll(async ({ request }) => {
    // Cascades the roles, agents and consultations.
    if (companyId) {
      await request.delete(`/api/company/${companyId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }
    if (previousStubConfig) await putStubConfig(request, previousStubConfig);
  });

  const startChat = async (page: Page): Promise<void> => {
    await gotoSignedIn(page, `/company/${companyId}`);
    await page
      .getByRole('button', { name: ADD_NEW_TRIGGER, exact: true })
      .click();
    await page.getByRole('menuitem', { name: NEW_CHAT_ITEM }).click();
    await page.getByRole('menuitem', { name: askerName }).click();
  };

  test('is followed in the asking transcript, and opens the consulted conversation', async ({
    page,
  }) => {
    await startChat(page);
    const panel = page.getByRole('region', { name: chatWithRole(askerName) });
    await panel
      .getByRole('textbox', { name: messageLabel(askerName) })
      .fill(`${askMarker} please find out the answer`);
    await panel.getByRole('button', { name: SEND_LABEL, exact: true }).click();

    // The question is shown as asked, whether or not the answer is in yet.
    await expect(panel.getByText(asked(consultedName))).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      panel.getByText(`${questionMarker} what is the answer?`, { exact: true }),
    ).toBeVisible();

    // Once answered the waiting line must be gone; the stub may be too fast
    // to catch it, so it is not asserted on its own.
    await expect(panel.getByText(answered(consultedName))).toBeVisible({
      timeout: 30_000,
    });
    await expect(panel.getByText(answer, { exact: true })).toBeVisible();
    await expect(panel.getByText(working(consultedName))).toHaveCount(0);

    // Both the asked and the answered entry carry the button; use the latest.
    await panel
      .getByRole('button', { name: openConversation(consultedName) })
      .last()
      .click();
    // Opened read-only, so it is labelled as one listened in on; the stack
    // replays its history before the question appears.
    const consulted = page.getByRole('region', {
      name: `Listening in: ${consultedName}`,
    });
    await expect(consulted).toBeVisible({ timeout: 15_000 });
    await expect(
      consulted.getByText(`Question: ${questionMarker} what is the answer?`),
    ).toBeVisible({ timeout: 15_000 });
  });
});
