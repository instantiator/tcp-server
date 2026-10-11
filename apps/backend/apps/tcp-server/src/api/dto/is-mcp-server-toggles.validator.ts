import { MCP_REGISTRY } from '@tcp/shared';
import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

/** The servers a toggle may name: those the system knows how to reach. */
const SERVER_NAMES: ReadonlySet<string> = new Set(
  MCP_REGISTRY.map((s) => s.name),
);

function isToggles(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([name, on]) => SERVER_NAMES.has(name) && typeof on === 'boolean',
    )
  );
}

/**
 * Accepts `null` or an object mapping registry server names to booleans, e.g.
 * `{ "records": false }`. A misspelt server name would otherwise be stored and
 * silently do nothing, so it's refused with the list of names that work.
 */
export function IsMcpServerToggles(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (object: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isMcpServerToggles',
      target: object.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return value === null || isToggles(value);
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} must map MCP server names (${[...SERVER_NAMES].join(', ')}) to true or false, e.g. { "records": false }`;
        },
      },
    });
  };
}
