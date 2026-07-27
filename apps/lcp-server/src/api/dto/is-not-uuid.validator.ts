import { UUID_RE } from '@lcp/shared';
import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

/**
 * Rejects a value that looks like a UUID. Applied to human-chosen identifier
 * fields (e.g. `slug`) so they can never be confused with an auto-generated
 * id — the same rule `assertNotUuid` enforces again at the entity layer
 * (`@lcp/shared`'s `TcpCompany`/`TcpRole` `@BeforeInsert`/`@BeforeUpdate`
 * hooks) as a backstop for writes that bypass this DTO.
 */
export function IsNotUuid(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (object: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isNotUuid',
      target: object.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return typeof value !== 'string' || !UUID_RE.test(value);
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} must not look like a UUID (reserved for ids)`;
        },
      },
    });
  };
}
