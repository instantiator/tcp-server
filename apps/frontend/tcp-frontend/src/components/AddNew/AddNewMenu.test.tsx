import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoleDTO } from '../../api/dtos';
import { t } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import {
  installFetchMock,
  respondByRoute,
  type RouteResponse,
} from '../../test-support/fetch-mock';
import { ChatContext, type NewChat } from '../ChatDialog/useChat';
import { AddNewMenu } from './AddNewMenu';

const COMPANY_ID = 'company-1';
const ROLES_ROUTE = new RegExp(`/api/company/${COMPANY_ID}/roles`);

const roleFixture = (id: string, name: string): RoleDTO => ({
  id,
  companyId: COMPANY_ID,
  slug: id,
  name,
  description: 'd',
  knowledgeDomains: [],
  mcpServerList: [],
  queryIndex: 0,
});

const ROLE_LEGAL = roleFixture('role-legal', 'Legal');
const ROLE_SALES = roleFixture('role-sales', 'Sales');

interface Routes {
  readonly roles?: RouteResponse;
}

const respond = (overrides: Routes = {}): void => {
  respondByRoute([
    [ROLES_ROUTE, overrides.roles ?? { body: [ROLE_LEGAL, ROLE_SALES] }],
  ]);
};

const renderAddNewMenu = (
  startChat: (chat: NewChat) => Promise<void> = vi
    .fn()
    .mockResolvedValue(undefined),
) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    queryClient,
    startChat,
    ...render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <ChatContext.Provider
            value={{ openChat: vi.fn(), closeChat: vi.fn(), startChat }}
          >
            <AddNewMenu companyId={COMPANY_ID} />
          </ChatContext.Provider>
        </QueryClientProvider>
      </StrictMode>,
    ),
  };
};

const trigger = () => screen.getByRole('button', { name: t('addNew.trigger') });

/** Waits for the roles query to settle, so the submenu shows real items. */
const waitForRolesLoaded = () =>
  waitFor(() => {
    expect(screen.queryByText(t('addNew.loadingRoles'))).toBeNull();
  });

describe('AddNewMenu', () => {
  beforeEach(() => {
    installFetchMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('keyboard navigation', () => {
    it('walks the whole menu tree by keyboard, and returns focus on close', async () => {
      respond();
      const user = userEvent.setup();
      renderAddNewMenu();

      await user.tab();
      expect(trigger()).toHaveFocus();

      await user.keyboard('{Enter}');
      const createTaskItem = await screen.findByRole('menuitem', {
        name: t('addNew.createTask'),
      });
      expect(createTaskItem).toHaveFocus();

      await user.keyboard('{ArrowDown}');
      const newChatItem = screen.getByRole('menuitem', {
        name: t('addNew.newChat'),
      });
      expect(newChatItem).toHaveFocus();

      await user.keyboard('{ArrowRight}');
      await waitForRolesLoaded();
      const firstRole = await screen.findByRole('menuitem', {
        name: ROLE_LEGAL.name,
      });
      expect(firstRole).toHaveFocus();

      await user.keyboard('{ArrowLeft}');
      expect(newChatItem).toHaveFocus();
      expect(
        screen.queryByRole('menuitem', { name: ROLE_LEGAL.name }),
      ).toBeNull();

      await user.keyboard('{Escape}');
      // React Aria restores focus on the animation frame after the overlay
      // unmounts, which does not settle within userEvent's own await (see
      // `shell/Header.test.tsx`'s equivalent case).
      await waitFor(() => {
        expect(screen.queryByRole('menu')).toBeNull();
        expect(trigger()).toHaveFocus();
      });
    });

    it('opens the "New chat" submenu with Space or Enter, not only ArrowRight', async () => {
      respond();
      const user = userEvent.setup();
      renderAddNewMenu();

      await user.click(trigger());
      await screen.findByRole('menuitem', { name: t('addNew.createTask') });
      // A mouse click opens the menu with focus on the menu itself, not an
      // item — standard menu-button behaviour, since a mouse user does not
      // need a highlighted item until they start using the keyboard. The
      // first `ArrowDown` is what lands on the first item; a second one is
      // needed to reach "New chat".
      await user.keyboard('{ArrowDown}{ArrowDown}');
      const newChatItem = screen.getByRole('menuitem', {
        name: t('addNew.newChat'),
      });
      expect(newChatItem).toHaveFocus();

      await user.keyboard('{Enter}');
      await waitForRolesLoaded();
      expect(
        await screen.findByRole('menuitem', { name: ROLE_LEGAL.name }),
      ).toBeInTheDocument();
    });
  });

  it('creates a new task from the menu, keyboard-only, and returns focus to the trigger on close', async () => {
    respond();
    const user = userEvent.setup();
    renderAddNewMenu();

    await user.tab();
    await user.keyboard('{Enter}');
    await screen.findByRole('menuitem', { name: t('addNew.createTask') });
    await user.keyboard('{Enter}');

    const dialog = await screen.findByRole('dialog', {
      name: t('task.create.heading'),
    });
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(trigger()).toHaveFocus();
    });
  });

  it('starts a chat with the chosen role, showing progress and disabling the other roles', async () => {
    let resolveStart: (() => void) | undefined;
    const startChat = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    );
    respond();
    const user = userEvent.setup();
    renderAddNewMenu(startChat);

    await user.click(trigger());
    await user.click(
      screen.getByRole('menuitem', { name: t('addNew.newChat') }),
    );
    await waitForRolesLoaded();
    await user.click(screen.getByRole('menuitem', { name: ROLE_SALES.name }));

    expect(startChat).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      roleId: ROLE_SALES.id,
      roleName: ROLE_SALES.name,
    });

    const startingItem = await screen.findByRole('menuitem', {
      name: t('addNew.starting', { role: ROLE_SALES.name }),
    });
    expect(startingItem).toHaveAttribute('aria-disabled', 'true');
    const otherItem = screen.getByRole('menuitem', { name: ROLE_LEGAL.name });
    expect(otherItem).toHaveAttribute('aria-disabled', 'true');
    // Both the top menu and the roles submenu are open — and both carry
    // `role="menu"` — while the attempt is pending.
    expect(screen.getAllByRole('menu').length).toBeGreaterThan(0);

    await act(async () => {
      resolveStart?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryAllByRole('menu')).toHaveLength(0);
    });
  });

  it('shows the error and references it from the trigger when starting a chat fails', async () => {
    const startChat = vi.fn().mockRejectedValue(new Error('network down'));
    respond();
    const user = userEvent.setup();
    renderAddNewMenu(startChat);

    await user.click(trigger());
    await user.click(
      screen.getByRole('menuitem', { name: t('addNew.newChat') }),
    );
    await waitForRolesLoaded();
    await user.click(screen.getByRole('menuitem', { name: ROLE_SALES.name }));

    await waitFor(() => {
      expect(screen.queryAllByRole('menu')).toHaveLength(0);
    });

    const message = t('addNew.error', { role: ROLE_SALES.name });
    // Scoped to a `<p>`: the same text is also spoken into the announcer's
    // live region (`useStartChatAction` announces the same failure), and an
    // unscoped query matches both.
    const errorText = await screen.findByText(message, { selector: 'p' });
    expect(trigger()).toHaveAttribute('aria-describedby', errorText.id);
  });

  it('shows "no roles" in the submenu when the company has none', async () => {
    respond({ roles: { body: [] } });
    const user = userEvent.setup();
    renderAddNewMenu();

    await user.click(trigger());
    await user.click(
      screen.getByRole('menuitem', { name: t('addNew.newChat') }),
    );

    expect(
      await screen.findByRole('menuitem', { name: t('addNew.noRoles') }),
    ).toHaveAttribute('aria-disabled', 'true');
  });

  it('reaches the last of 50 roles by repeated ArrowDown', async () => {
    const many = Array.from({ length: 50 }, (_, index) =>
      roleFixture(
        `role-${String(index + 1).padStart(2, '0')}`,
        `Role ${String(index + 1).padStart(2, '0')}`,
      ),
    );
    respond({ roles: { body: many } });
    const user = userEvent.setup();
    renderAddNewMenu();

    // Keyboard, not a click, to open the submenu — a mouse click opens it
    // without moving focus inside, since a sighted mouse user does not need
    // it (the same reason `ArrowRight` and `Enter`/`Space` do move focus in
    // the keyboard-navigation tests above).
    await user.tab();
    await user.keyboard('{Enter}');
    await screen.findByRole('menuitem', { name: t('addNew.createTask') });
    await user.keyboard('{ArrowDown}{ArrowRight}');
    await waitForRolesLoaded();
    await screen.findByRole('menuitem', { name: 'Role 01' });
    expect(screen.getByRole('menuitem', { name: 'Role 01' })).toHaveFocus();

    // Walking one key press at a time is the point of this test.
    for (let i = 0; i < many.length - 1; i += 1) {
      await user.keyboard('{ArrowDown}');
    }

    expect(screen.getByRole('menuitem', { name: 'Role 50' })).toHaveFocus();
  });

  describe('accessibility', () => {
    it('has no violations with the top menu open', async () => {
      respond();
      const user = userEvent.setup();
      renderAddNewMenu();

      await user.click(trigger());
      await screen.findByRole('menuitem', { name: t('addNew.createTask') });

      await expectNoA11yViolations(document.body);
    });

    it('has no violations with the roles submenu open', async () => {
      respond();
      const user = userEvent.setup();
      renderAddNewMenu();

      await user.click(trigger());
      await user.click(
        screen.getByRole('menuitem', { name: t('addNew.newChat') }),
      );
      await waitForRolesLoaded();
      await screen.findByRole('menuitem', { name: ROLE_LEGAL.name });

      await expectNoA11yViolations(document.body);
    });
  });
});
