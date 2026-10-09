#!/usr/bin/env node
import { Command } from 'commander';
import { Agent, setGlobalDispatcher } from 'undici';
import { registerCancelTask } from './commands/cancel-task';
import { registerChat } from './commands/chat';
import { registerCreateTask } from './commands/create-task';
import { registerDeleteCompany } from './commands/delete-company';
import { registerDeleteKnowledge } from './commands/delete-knowledge';
import { registerDismissCap } from './commands/dismiss-cap';
import { registerDismissNotification } from './commands/dismiss-notification';
import { registerReindexKnowledge } from './commands/reindex-knowledge';
import { registerDeleteRole } from './commands/delete-role';
import { registerDownloadSharedDocument } from './commands/download-shared-document';
import { registerEavesdrop } from './commands/eavesdrop';
import { registerEstimateContextWindow } from './commands/estimate-context-window';
import { registerGetKnowledge } from './commands/get-knowledge';
import { registerGetKnowledgeIndexStatus } from './commands/get-knowledge-index-status';
import { registerGetTask } from './commands/get-task';
import { registerGetToken } from './commands/get-token';
import { registerListAgents } from './commands/list-agents';
import { registerListAssignments } from './commands/list-assignments';
import { registerListCompanies } from './commands/list-companies';
import { registerListKnowledge } from './commands/list-knowledge';
import { registerListOpenQueries } from './commands/list-open-queries';
import { registerListRoles } from './commands/list-roles';
import { registerListTasks } from './commands/list-tasks';
import { registerNotifications } from './commands/notifications';
import { registerOpenDocumentStore } from './commands/open-document-store';
import { registerOpenSwagger } from './commands/open-swagger';
import { registerQueryKnowledge } from './commands/query-knowledge';
import { registerReadQuery } from './commands/read-query';
import { registerRespond } from './commands/respond';
import { registerRestoreCap } from './commands/restore-cap';
import { registerResumeCompany } from './commands/resume-company';
import { registerResumeTask } from './commands/resume-task';
import { registerPauseTask } from './commands/pause-task';
import { registerSetCompany } from './commands/set-company';
import { registerSetPlanner } from './commands/set-planner';
import { registerSetRole } from './commands/set-role';
import { registerSetTask } from './commands/set-task';
import { registerShutdown } from './commands/shutdown';
import { registerRestart } from './commands/restart';
import { registerCancelShutdown } from './commands/cancel-shutdown';
import { registerGetHealth } from './commands/get-health';
import { registerStartTask } from './commands/start-task';
import { registerStoreKnowledge } from './commands/store-knowledge';
import { registerTui } from './commands/tui';
import { registerUploadSharedDocument } from './commands/upload-shared-document';
import { registerUsage } from './commands/usage';
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
  .name('tcp-cli')
  .description('Developer CLI for the TCP server')
  .version('0.0.1')
  .option(
    '-s, --tcp-server <url>',
    'TCP server base URL',
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
  );

registerGetToken(program);
registerListCompanies(program);
registerListRoles(program);
registerListKnowledge(program);
registerGetKnowledge(program);
registerStoreKnowledge(program);
registerDeleteKnowledge(program);
registerReindexKnowledge(program);
registerGetKnowledgeIndexStatus(program);
registerQueryKnowledge(program);
registerOpenDocumentStore(program);
registerOpenSwagger(program);
registerSetCompany(program);
registerSetRole(program);
registerDeleteCompany(program);
registerDeleteRole(program);
registerChat(program);
registerTui(program);
registerListOpenQueries(program);
registerReadQuery(program);
registerRespond(program);
registerDownloadSharedDocument(program);
registerUploadSharedDocument(program);
registerEstimateContextWindow(program);
registerValidateSharedDocument(program);
registerCreateTask(program);
registerListTasks(program);
registerGetTask(program);
registerSetTask(program);
registerSetPlanner(program);
registerStartTask(program);
registerCancelTask(program);
registerListAgents(program);
registerListAssignments(program);
registerEavesdrop(program);
registerShutdown(program);
registerRestart(program);
registerCancelShutdown(program);
registerGetHealth(program);
registerUsage(program);
registerNotifications(program);
registerDismissNotification(program);
registerDismissCap(program);
registerRestoreCap(program);
registerPauseTask(program);
registerResumeTask(program);
registerResumeCompany(program);

program.parse(process.argv);
