/**
 * System tests for the API surface exercised by lcp-cli.
 *
 * These tests confirm the full round-trip that each CLI verb performs:
 * the server must reach Zitadel internally (catching the ECONNREFUSED
 * regression), and all JWT-guarded endpoints must be reachable.
 *
 * Run via: ./scripts/run-api-tests.sh
 * Requires: docker compose --profile auth up, Zitadel lcp org configured.
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { LcpCompany, LcpRole } from '../../libs/lcp-shared/src';
import { ApiHelper, BASE, ChatResponse, RUN_ID } from './helpers/ApiHelper';

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name));

describe('lcp-cli API flows', () => {
  // device authorization: the server must reach Zitadel internally to start/poll the flow.
  // Regression: ECONNREFUSED if Zitadel is not reachable or ready.
  describe('device authorization (POST /api/auth/device, POST /api/auth/device/token)', () => {
    it('starts a device authorization', async () => {
      const device = await ApiHelper.startDeviceAuthorization();
      expect(device.device_code).toBeDefined();
      expect(device.user_code).toBeDefined();
      expect(device.verification_uri).toContain('/device');
    });
    it('reports pending before login completes', async () => {
      const device = await ApiHelper.startDeviceAuthorization();
      const poll = await ApiHelper.pollDeviceToken(device.device_code);
      expect(poll.status).toBe('pending');
    });
  });

  describe('machine token (client_credentials)', () => {
    it('returns an access_token for a valid client secret', async () => {
      const token = await ApiHelper.getMachineToken();
      expect(token).toBeDefined();
    });
    it('returns an error for an invalid client secret', async () => {
      // Zitadel's token endpoint reports invalid_client as HTTP 400, not 401.
      const token = await ApiHelper.getMachineToken('wrong-secret', 400);
      expect(token).toBeUndefined();
    });
  });

  describe('authorised endpoint', () => {
    let api: ApiHelper;

    beforeAll(async () => {
      const token = await ApiHelper.getMachineToken();
      api = new ApiHelper(token!);
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

          describe('role knowledge (/api/role/:roleId/knowledge)', () => {
            const scopePath = () => `role/${role.id}`;

            it('GET lists no documents initially', async () => {
              const docs = await api.listKnowledge(scopePath());
              expect(docs).toEqual([]);
            });

            it('POST stores an OKF document and it is then listed', async () => {
              const stored = await api.storeKnowledge(
                scopePath(),
                'role-doc.md',
                '---\ntitle: Role doc\n---\n\nContent.',
              );
              expect(stored?.name).toBe('role-doc.md');

              const docs = await api.listKnowledge(scopePath());
              expect(docs.some((d) => d.name === 'role-doc.md')).toBe(true);
            });

            it('GET :filename returns the stored content', async () => {
              const content = await api.getKnowledgeText(
                scopePath(),
                'role-doc.md',
              );
              expect(content).toContain('Content.');
            });

            it('GET :filename returns 404 for an unknown file', async () => {
              await api.getKnowledgeText(scopePath(), 'no-such-file.md', 404);
            });

            it('POST returns 422 for a document missing OKF front-matter', async () => {
              await api.storeKnowledge(
                scopePath(),
                'invalid.md',
                '# no front-matter',
                422,
              );
            });

            describe('wider format support (010.7.1)', () => {
              it('converts a .txt upload, falling back to the filename stem as title', async () => {
                const stored = await api.storeKnowledge(
                  scopePath(),
                  'notes.txt',
                  'Plain text notes.',
                );
                expect(stored?.name).toBe('notes.md');

                const content = await api.getKnowledgeText(
                  scopePath(),
                  'notes.md',
                );
                expect(content).toMatch(/^---\ntitle: notes\n---/);
                expect(content).toContain('Plain text notes.');
              });

              it('converts a .html upload, using the <title> tag and GFM tables', async () => {
                const html =
                  '<html><head><title>HTML Doc</title></head><body>' +
                  '<h1>Heading</h1><p>Body text.</p>' +
                  '<table><tr><th>A</th></tr><tr><td>1</td></tr></table></body></html>';
                const stored = await api.storeKnowledge(
                  scopePath(),
                  'page.html',
                  html,
                );
                expect(stored?.name).toBe('page.md');

                const content = await api.getKnowledgeText(
                  scopePath(),
                  'page.md',
                );
                expect(content).toMatch(/title: HTML Doc/);
                expect(content).toContain('# Heading');
                expect(content).toContain('Body text.');
                expect(content).toContain('| A |');
              });

              it('wraps a .csv upload in a fenced code block', async () => {
                const stored = await api.storeKnowledge(
                  scopePath(),
                  'sales.csv',
                  'a,b\n1,2\n',
                );
                expect(stored?.name).toBe('sales.md');

                const content = await api.getKnowledgeText(
                  scopePath(),
                  'sales.md',
                );
                expect(content).toMatch(/title: sales/);
                expect(content).toContain('```csv\na,b\n1,2\n\n```');
              });

              it('wraps a .json upload in a fenced code block', async () => {
                const stored = await api.storeKnowledge(
                  scopePath(),
                  'settings.json',
                  '{"a":1}',
                );
                expect(stored?.name).toBe('settings.md');

                const content = await api.getKnowledgeText(
                  scopePath(),
                  'settings.md',
                );
                expect(content).toContain('```json\n{"a":1}\n```');
              });

              it('wraps a .yaml upload in a fenced code block', async () => {
                const stored = await api.storeKnowledge(
                  scopePath(),
                  'config.yaml',
                  'a: 1\n',
                );
                expect(stored?.name).toBe('config.md');

                const content = await api.getKnowledgeText(
                  scopePath(),
                  'config.md',
                );
                expect(content).toContain('```yaml\na: 1\n\n```');
              });

              it('rejects malformed JSON with a 400', async () => {
                await api.storeKnowledge(
                  scopePath(),
                  'broken.json',
                  '{not json',
                  400,
                );
              });

              it('converts a .pdf upload, extracting its text', async () => {
                const stored = await api.storeKnowledge(
                  scopePath(),
                  'report.pdf',
                  fixture('sample.pdf'),
                );
                expect(stored?.name).toBe('report.md');

                const content = await api.getKnowledgeText(
                  scopePath(),
                  'report.md',
                );
                expect(content).toMatch(/title: report/);
                expect(content).toContain('Sample PDF content');
              });

              it('converts a .docx upload, using its first heading as title', async () => {
                const stored = await api.storeKnowledge(
                  scopePath(),
                  'manual.docx',
                  fixture('sample.docx'),
                );
                expect(stored?.name).toBe('manual.md');

                const content = await api.getKnowledgeText(
                  scopePath(),
                  'manual.md',
                );
                expect(content).toMatch(/title: Sample Heading/);
                expect(content).toContain('Sample docx content.');
              });

              it('rejects an unsupported extension with a 400', async () => {
                await api.storeKnowledge(
                  scopePath(),
                  'archive.zip',
                  'irrelevant',
                  400,
                );
              });

              it('rejects a converted filename that collides with an existing document', async () => {
                await api.storeKnowledge(
                  scopePath(),
                  'collide.txt',
                  'First upload.',
                );
                await api.storeKnowledge(
                  scopePath(),
                  'collide.json',
                  '{"second":true}',
                  409,
                );
              });
            });

            it('DELETE :filename removes the document', async () => {
              await api.deleteKnowledge(scopePath(), 'role-doc.md');
              const docs = await api.listKnowledge(scopePath());
              expect(docs.some((d) => d.name === 'role-doc.md')).toBe(false);
            });

            it('DELETE :filename is idempotent for an unknown file', async () => {
              await api.deleteKnowledge(scopePath(), 'no-such-file.md');
            });

            it('GET returns 404 for an unknown role', async () => {
              const res = await fetch(
                `${BASE}/api/role/${randomUUID()}/knowledge`,
                { headers: { Authorization: `Bearer ${api.token}` } },
              );
              expect(res.status).toBe(404);
            });
          });
        });
      });

      describe('company knowledge (/api/company/:companyId/knowledge)', () => {
        const scopePath = () => `company/${company.id}`;

        it('GET lists no documents initially', async () => {
          const docs = await api.listKnowledge(scopePath());
          expect(docs).toEqual([]);
        });

        it('POST stores an OKF document and it is then listed', async () => {
          const stored = await api.storeKnowledge(
            scopePath(),
            'shared-doc.md',
            '---\ntitle: Shared doc\n---\n\nShared content.',
          );
          expect(stored?.name).toBe('shared-doc.md');

          const docs = await api.listKnowledge(scopePath());
          expect(docs.some((d) => d.name === 'shared-doc.md')).toBe(true);
        });

        it('GET :filename returns the stored content', async () => {
          const content = await api.getKnowledgeText(
            scopePath(),
            'shared-doc.md',
          );
          expect(content).toContain('Shared content.');
        });

        it('DELETE :filename removes the document', async () => {
          await api.deleteKnowledge(scopePath(), 'shared-doc.md');
          const docs = await api.listKnowledge(scopePath());
          expect(docs.some((d) => d.name === 'shared-doc.md')).toBe(false);
        });

        it('converts a non-.md upload under the shared scope too (010.7.1)', async () => {
          const html =
            '<html><head><title>Shared HTML</title></head><body><p>Text.</p></body></html>';
          const stored = await api.storeKnowledge(
            scopePath(),
            'shared-page.html',
            html,
          );
          expect(stored?.name).toBe('shared-page.md');

          const content = await api.getKnowledgeText(
            scopePath(),
            'shared-page.md',
          );
          expect(content).toMatch(/title: Shared HTML/);
          expect(content).toContain('Text.');
        });

        it('resolves the company by slug as well as by id', async () => {
          const docs = await api.listKnowledge(`company/${company.slug}`);
          expect(Array.isArray(docs)).toBe(true);
        });
      });
    });
  });
});

describe('storage proxy', () => {
  let token: string;

  beforeAll(async () => {
    token = (await ApiHelper.getMachineToken())!;
  });

  const authHeaders = () => ({ Authorization: `Bearer ${token}` });

  describe('POST /api/storage/:path + GET /api/storage?path=', () => {
    const key = `api-test/${RUN_ID}/proxy-test.txt`;
    const content = `proxy test content ${RUN_ID}`;

    it('uploads a file and returns key and size', async () => {
      const form = new FormData();
      form.append(
        'file',
        new Blob([content], { type: 'text/plain' }),
        'proxy-test.txt',
      );
      const res = await fetch(
        `${BASE}/api/storage?path=${encodeURIComponent(key)}`,
        { method: 'POST', headers: authHeaders(), body: form },
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as { key: string; size: number };
      expect(body.key).toBe(key);
      expect(body.size).toBe(Buffer.byteLength(content));
    });

    it('downloads the uploaded file back', async () => {
      const res = await fetch(
        `${BASE}/api/storage?path=${encodeURIComponent(key)}`,
        { headers: authHeaders() },
      );
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe(content);
    });

    it('returns 404 for a non-existent key', async () => {
      const res = await fetch(
        `${BASE}/api/storage?path=${encodeURIComponent('api-test/does-not-exist.txt')}`,
        { headers: authHeaders() },
      );
      expect(res.status).toBe(404);
    });

    it('returns 400 for a path traversal attempt', async () => {
      const res = await fetch(
        `${BASE}/api/storage?path=${encodeURIComponent('../etc/passwd')}`,
        { headers: authHeaders() },
      );
      expect(res.status).toBe(400);
    });

    it('returns 401 without a token', async () => {
      const res = await fetch(
        `${BASE}/api/storage?path=${encodeURIComponent(key)}`,
      );
      expect(res.status).toBe(401);
    });
  });
});
