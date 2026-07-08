#!/usr/bin/env node
import { Command } from 'commander';
import { Agent, setGlobalDispatcher } from 'undici';
import { registerChat } from './commands/chat';
import { registerDeleteCompany } from './commands/delete-company';
import { registerDeleteRole } from './commands/delete-role';
import { registerDownloadSharedDocument } from './commands/download-shared-document';
import { registerEstimateContextWindow } from './commands/estimate-context-window';
import { registerGetToken } from './commands/get-token';
import { registerListCompanies } from './commands/list-companies';
import { registerListOpenQueries } from './commands/list-open-queries';
import { registerListRoleDocuments } from './commands/list-role-documents';
import { registerListRoles } from './commands/list-roles';
import { registerOpenDocumentStore } from './commands/open-document-store';
import { registerOpenSwagger } from './commands/open-swagger';
import { registerReadQuery } from './commands/read-query';
import { registerRemoveRoleDocuments } from './commands/remove-role-documents';
import { registerRespond } from './commands/respond';
import { registerSetCompany } from './commands/set-company';
import { registerSetRole } from './commands/set-role';
import { registerStoreRoleDocuments } from './commands/store-role-documents';
import { registerUploadSharedDocument } from './commands/upload-shared-document';
import { registerValidateSharedDocument } from './commands/validate-shared-document';

// Node.js 18+ built-in fetch uses undici with a 5-minute headersTimeout by
// default. The chat SSE event stream stays open for the whole turn (which can
// exceed 5 minutes across a consultation cycle), so raise the dispatcher's
// timeouts to match the CLI's own 35-minute abort ceiling.
setGlobalDispatcher(
  new Agent({ headersTimeout: 35 * 60 * 1000, bodyTimeout: 35 * 60 * 1000 }),
);

const program = new Command();

program
  .name('lcp-cli')
  .description('Developer CLI for the LCP server')
  .version('0.0.1')
  .option(
    '-s, --lcp-server <url>',
    'LCP server base URL',
    'http://localhost:3000',
  )
  .option('-t, --access-token <token>', 'Bearer token (skips auth flow)')
  .option(
    '-T, --refresh-token <token>',
    'Refresh token (renews an expired access token)',
  )
  .option(
    '-E, --access-token-env-var <var>',
    'Name of env var holding the token',
  )
  .option('-u, --username <user>', 'OIDC username')
  .option('-p, --password <pass>', 'OIDC password (omit to be prompted)');

registerGetToken(program);
registerListCompanies(program);
registerListRoles(program);
registerListRoleDocuments(program);
registerStoreRoleDocuments(program);
registerRemoveRoleDocuments(program);
registerOpenDocumentStore(program);
registerOpenSwagger(program);
registerSetCompany(program);
registerSetRole(program);
registerDeleteCompany(program);
registerDeleteRole(program);
registerChat(program);
registerListOpenQueries(program);
registerReadQuery(program);
registerRespond(program);
registerDownloadSharedDocument(program);
registerUploadSharedDocument(program);
registerEstimateContextWindow(program);
registerValidateSharedDocument(program);

program.parse(process.argv);
