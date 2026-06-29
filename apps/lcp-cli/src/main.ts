#!/usr/bin/env node
import { Command } from 'commander';
import { registerGetToken } from './commands/get-token';
import { registerListCompanies } from './commands/list-companies';
import { registerListRoles } from './commands/list-roles';
import { registerListRoleDocuments } from './commands/list-role-documents';
import { registerStoreRoleDocuments } from './commands/store-role-documents';
import { registerRemoveRoleDocuments } from './commands/remove-role-documents';
import { registerOpenDocumentStore } from './commands/open-document-store';
import { registerSetCompany } from './commands/set-company';
import { registerSetRole } from './commands/set-role';
import { registerChat } from './commands/chat';
import { registerListOpenQueries } from './commands/list-open-queries';
import { registerReadQuery } from './commands/read-query';
import { registerRespond } from './commands/respond';
import { registerDownloadSharedDocument } from './commands/download-shared-document';
import { registerUploadSharedDocument } from './commands/upload-shared-document';

const program = new Command();

program
  .name('lcp-cli')
  .description('Developer CLI for the Little Computer People LCP server')
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
registerSetCompany(program);
registerSetRole(program);
registerChat(program);
registerListOpenQueries(program);
registerReadQuery(program);
registerRespond(program);
registerDownloadSharedDocument(program);
registerUploadSharedDocument(program);

program.parse(process.argv);
