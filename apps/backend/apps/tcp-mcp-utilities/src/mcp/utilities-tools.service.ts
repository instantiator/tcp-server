import { ToolResult, err, ok, registerDescribeServer } from '@tcp/shared';
import { Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CalcError } from '../calc/calc-error';
import { calculate } from '../calc/calculate';
import { DATE_OPERATIONS, dateMath } from '../calc/date-math';
import { convertUnits } from '../calc/units';
import { utilitiesPrompts } from '../utilities-prompts';
import { utilitiesToolDescriptions } from '../utilities-tool-descriptions';

/**
 * Runs a calculation, returning a {@link CalcError} to the model as an error
 * result it can correct, rather than failing the tool call.
 */
function attempt(run: () => string): ToolResult {
  try {
    return ok(run());
  } catch (e) {
    if (e instanceof CalcError) return err(e.message);
    throw e;
  }
}

/**
 * Builds fresh {@link McpServer} instances with the deterministic utilities
 * tools. Stateless: nothing is stored, and identity isn't needed, so no tool
 * takes a `companyId` or `agentId`. Calls are audited on the agent side.
 */
@Injectable()
export class UtilitiesToolsService {
  /** Creates and returns a configured McpServer with all utilities tools registered. */
  createServer(): McpServer {
    const server = new McpServer({
      name: 'tcp-mcp-utilities',
      version: '1.0.0',
    });
    registerDescribeServer(
      server,
      utilitiesToolDescriptions.describe_server,
      utilitiesPrompts.describe_server,
    );
    this.registerCalculate(server);
    this.registerDateMath(server);
    this.registerConvertUnits(server);
    return server;
  }

  private registerCalculate(server: McpServer): void {
    server.registerTool(
      'calculate',
      {
        description: utilitiesToolDescriptions.calculate,
        inputSchema: {
          expression: z
            .string()
            .describe('The expression, e.g. "round(3 * 4.99 * 1.2, 2)".'),
        },
      },
      ({ expression }): ToolResult => attempt(() => calculate(expression)),
    );
  }

  private registerDateMath(server: McpServer): void {
    const count = (unit: string) =>
      z.number().int().optional().describe(`Whole ${unit} to move by.`);
    server.registerTool(
      'date_math',
      {
        description: utilitiesToolDescriptions.date_math,
        inputSchema: {
          operation: z.enum(DATE_OPERATIONS).describe('What to calculate.'),
          date: z.string().describe('The starting date, YYYY-MM-DD.'),
          other_date: z
            .string()
            .optional()
            .describe('The end date for `difference`, YYYY-MM-DD.'),
          years: count('years'),
          months: count('months'),
          weeks: count('weeks'),
          days: count('days (business days for `add_business_days`)'),
          holidays: z
            .array(z.string())
            .optional()
            .describe('Dates (YYYY-MM-DD) that are not business days.'),
          tax_year_start: z
            .string()
            .optional()
            .describe('First day of the tax year, MM-DD. Default 04-06.'),
        },
      },
      (input): ToolResult => attempt(() => JSON.stringify(dateMath(input))),
    );
  }

  private registerConvertUnits(server: McpServer): void {
    server.registerTool(
      'convert_units',
      {
        description: utilitiesToolDescriptions.convert_units,
        inputSchema: {
          value: z.string().describe('The amount, as a decimal, e.g. "2.5".'),
          from: z.string().describe('The unit to convert from, e.g. "lb".'),
          to: z.string().describe('The unit to convert to, e.g. "kg".'),
        },
      },
      ({ value, from, to }): ToolResult =>
        attempt(
          () => `${value} ${from} = ${convertUnits(value, from, to)} ${to}`,
        ),
    );
  }
}
