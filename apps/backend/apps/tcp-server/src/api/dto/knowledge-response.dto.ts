import { ApiProperty } from '@nestjs/swagger';
import { UUID } from 'crypto';

/**
 * Response shapes for `knowledge.controller.ts`'s GET routes.
 *
 * These routes don't return entities — they return values shaped by
 * `KnowledgeService`'s own interfaces (`DocumentSummary`, `KnowledgeStatus`,
 * `CompanyKnowledgeStatus`) and `RagChunk` from `@tcp/shared`. The
 * `@nestjs/swagger` CLI plugin synthesises `@ApiProperty` metadata by reading
 * the AST of classes; it cannot read an interface, because an interface is
 * erased at compile time and leaves nothing for the plugin to visit. A route
 * whose return type is an interface is therefore published to
 * `schema.json`/`schema.d.ts` as `Record<string, never>` — an object type
 * with no properties — and openapi-typescript renders that into the web
 * client verbatim. The failure is silent at its cause and only surfaces as a
 * compile error at a call site, in a different package, whenever someone
 * finally tries to read a field off the result.
 *
 * The classes below mirror those interfaces field for field so the plugin has
 * something to read. They are not returned by any handler — the service
 * keeps returning its interfaces, which are structurally assignable to these
 * classes — they exist purely to document the wire shape.
 */

/** {@link DocumentSummary}, published as a class so the Swagger plugin can read it. */
export class KnowledgeDocumentResponseDto {
  /** Full MinIO object key (used as `KnowledgeChunk.documentPath`). */
  key!: string;
  /** Filename within the knowledge scope's directory. */
  name!: string;
  /** File size in bytes. */
  size!: number;
  /** ISO 8601 last-modified timestamp. */
  lastModified!: string;
}

/** {@link KnowledgeStatus}, published as a class so the Swagger plugin can read it. */
export class KnowledgeStatusResponseDto {
  /** Number of documents currently stored in the scope. */
  documentCount!: number;
  /** Combined size in bytes of all documents in the scope. */
  totalBytes!: number;
  /** Number of RAG chunks currently indexed for the scope. */
  chunkCount!: number;
  /** Current `KnowledgeIndexState.generation` for the scope (0 if never bumped). */
  generation!: number;
  /** ISO 8601 timestamp of the last *successful* rebuild, or `null` if none has completed. */
  @ApiProperty({ type: String, nullable: true })
  lastIndexedAt!: string | null;
  /** True if a rebuild job for the scope is currently queued or running. */
  indexing!: boolean;
  /** Error message from the most recent failed rebuild, or `null` if the last rebuild succeeded (or none has run). */
  @ApiProperty({ type: String, nullable: true })
  lastError!: string | null;
  /** ISO 8601 timestamp {@link lastError} was recorded, or `null` if unset. */
  @ApiProperty({ type: String, nullable: true })
  lastErrorAt!: string | null;
}

/** A single role's entry in {@link CompanyKnowledgeStatusResponseDto.roles}. */
export class RoleKnowledgeStatusResponseDto {
  roleId!: UUID;
  roleSlug!: string;
  status!: KnowledgeStatusResponseDto;
}

/** {@link CompanyKnowledgeStatus}, published as a class so the Swagger plugin can read it. */
export class CompanyKnowledgeStatusResponseDto {
  /** Status of the company's shared (`knowledge/shared/`) scope. */
  shared!: KnowledgeStatusResponseDto;
  /** Status of each role's scope. */
  @ApiProperty({ type: RoleKnowledgeStatusResponseDto, isArray: true })
  roles!: RoleKnowledgeStatusResponseDto[];
}

/** {@link RagChunk}, published as a class so the Swagger plugin can read it. */
export class KnowledgeChunkResponseDto {
  /** Primary key of the `KnowledgeChunk` row. */
  id!: UUID;
  /** Path of the source document in company storage. */
  documentPath!: string;
  /** Zero-based position of this chunk in its source document. */
  chunkIndex!: number;
  /** Raw text content of the chunk. */
  content!: string;
  /** Cosine similarity score — 1.0 is identical, 0.0 is orthogonal. */
  similarity!: number;
}
