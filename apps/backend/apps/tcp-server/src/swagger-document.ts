import type { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger';

/** Enum values in a fixed order: by text, with `null` last. */
const byValue = (a: unknown, b: unknown): number => {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  // JSON text, so strings, numbers and booleans all compare without a guess.
  return (JSON.stringify(a) ?? '') < (JSON.stringify(b) ?? '') ? -1 : 1;
};

/**
 * Sorts every `enum` array in an OpenAPI document, in place.
 *
 * The Swagger plugin turns a string-literal union into an enum in the order
 * TypeScript happens to have created those literal types, which depends on
 * which files the compiler read first. Adding an unrelated file can reorder
 * an enum, and `schema.d.ts`, generated from this document, then drifts with
 * no real change. Sorting makes the document the same however it was built.
 */
export function sortEnums<T>(node: T): T {
  if (Array.isArray(node)) {
    for (const item of node) sortEnums(item);
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'enum' && Array.isArray(value)) value.sort(byValue);
      else sortEnums(value);
    }
  }
  return node;
}

/** The API description served at `/swagger`, with its enums in a fixed order. */
export function buildSwaggerDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('TCP Server')
    .setDescription('REST API for the TCP server')
    .setVersion('1.0')
    .addBearerAuth()
    .addApiKey(
      { type: 'apiKey', in: 'header', name: 'x-internal-api-key' },
      'internal-api-key',
    )
    .build();
  return sortEnums(SwaggerModule.createDocument(app, config));
}
