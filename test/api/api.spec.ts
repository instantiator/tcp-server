/**
 * System tests for the API surface exercised by lcp-cli.
 *
 * These tests confirm the full round-trip that each CLI verb performs:
 * the server must reach Keycloak internally (catching the ECONNREFUSED
 * regression), and all JWT-guarded endpoints must be reachable.
 *
 * Run via: ./scripts/run-api-tests.sh
 * Requires: docker compose --profile auth up, Keycloak lcp realm configured.
 */

import { LcpCompany, LcpRole } from '../../libs/lcp-shared/src';
import {
  ApiHelper,
  ChatResponse,
  PASSWORD,
  RUN_ID,
  USERNAME,
} from './helpers/ApiHelper';

describe('lcp-cli API flows', () => {
  // get-token: the server must reach Keycloak internally to exchange credentials.
  // Regression: ECONNREFUSED if Keycloak is not reachable or ready.
  describe('get-token (POST /api/auth/token)', () => {
    it('returns an access_token for valid credentials', async () => {
      const token = await ApiHelper.postCredentialsForToken(
        USERNAME,
        PASSWORD,
        200,
      );
      expect(token).toBeDefined();
    });
    it('returns 401 for invalid credentials', async () => {
      const token = await ApiHelper.postCredentialsForToken(
        USERNAME,
        'wrong-password',
        401,
      );
      expect(token).toBeUndefined();
    });
  });

  describe('authorised endpoint', () => {
    let api: ApiHelper;

    beforeAll(async () => {
      const token = await ApiHelper.postCredentialsForToken(
        USERNAME,
        PASSWORD,
        200,
      );
      api = new ApiHelper(token);
    });

    describe('POST /api/company', () => {
      it('creates a new company', async () => {
        const company = await api.createTestCompany(
          'Test company',
          'test-creation',
        );
        expect(company?.name).toEqual('Test company');
        expect(company?.slug).toEqual('test-creation');
      });
    });

    describe('with a company', () => {
      let company: LcpCompany;

      // Create a company for use with the remaining tests
      beforeAll(async () => {
        company = await api.createTestCompany('Test company', 'test-creation');
      });

      describe('PUT /api/company/:id', () => {
        it('updates the company', async () => {
          const response = await api.updateCompany(company.id, {
            name: 'Updated company',
          });
          expect(response.name).toEqual('Updated company');
        });
      });

      describe('GET /api/company', () => {
        it('lists the companies', async () => {
          const list = await api.listCompanies();
          expect(list.some((c) => c.id === company.id)).toBe(true);
        });
      });

      describe('POST /api/role', () => {
        it('creates a new role under the company', async () => {
          const role = await api.createTestRole(
            `test-role-${RUN_ID}`,
            company.id,
          );
          expect(role.companyId).toBe(company.id);
        });

        describe('with role', () => {
          let role: LcpRole;

          beforeAll(async () => {
            role = await api.createTestRole(`test-role-${RUN_ID}`, company.id);
            expect(role.companyId).toBe(company.id);
          });

          describe('PUT /api/role/:id', () => {
            it('updates the role', async () => {
              const updated = await api.updateRole(role.id, {
                description: 'Updated description',
              });
              expect(updated.description).toEqual('Updated description');
            });
          });

          describe('GET /api/company/:id/roles', () => {
            it('lists the roles for the company', async () => {
              const roles = await api.listRoles(company.id);
              expect(roles.some((r) => r.id === role.id)).toBeTruthy();
            });
          });

          describe('POST /api/agent/chat/start', () => {
            it('creates a chat agent', async () => {
              const agent = await api.startAgentChat(company.id, role.id);
              expect(agent.status).toBe('idle');
            });
          });

          describe('with agent', () => {
            let agent: ChatResponse;
            beforeAll(async () => {
              agent = await api.startAgentChat(company.id, role.id);
              expect(agent).toBeDefined();
            });

            describe('DELETE /api/agent/:id)', () => {
              it('deletes the chat agent', async () => {
                await api.deleteAgent(agent.id);
              });
            });
          });
        });
      });
    });
  });
});
