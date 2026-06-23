#!/usr/bin/env node
import { Command } from 'commander';
import { registerGetToken } from './commands/get-token';
import { registerListCompanies } from './commands/list-companies';
import { registerListRoles } from './commands/list-roles';
import { registerSetCompany } from './commands/set-company';
import { registerSetRole } from './commands/set-role';
import { registerChat } from './commands/chat';

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
    '-e, --access-token-env-var <var>',
    'Name of env var holding the token',
  )
  .option('-u, --username <user>', 'OIDC username')
  .option('-p, --password <pass>', 'OIDC password (omit to be prompted)');

registerGetToken(program);
registerListCompanies(program);
registerListRoles(program);
registerSetCompany(program);
registerSetRole(program);
registerChat(program);

program.parse(process.argv);
