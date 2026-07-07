import type { ValidationError } from '@lcp/shared';
import { UnprocessableEntityException } from '@nestjs/common';

/**
 * Thrown by {@link MinioStorageAdapter} when a document fails validation
 * before being written. Maps to `422 Unprocessable Entity` — the request
 * itself is well-formed, but its content is rejected. `errors[].llmHint` is
 * meant to be relayed back into the calling agent's context so it can act
 * on the failure directly.
 */
export class DocumentValidationException extends UnprocessableEntityException {
  constructor(errors: ValidationError[]) {
    super({ message: 'Document failed validation', errors });
  }
}
