import {
  Body,
  Controller,
  HttpCode,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { StorageObject, StorageService } from '../storage/storage.service';
import { ValidateSharedDocumentDto } from './dto/validate-shared-document.dto';

const GLOB_CHARS = /[*?]/;

/** Result for a single document checked by {@link StorageValidationController.validate}. */
interface ValidationEntry {
  path: string;
  found: boolean;
  size: number;
  valid: boolean;
  errors: string[];
}

/** Response shape for `POST /api/storage/validate`. */
interface ValidateSharedDocumentResponse {
  query: { path: string; recursive: boolean };
  validations: ValidationEntry[];
}

/** Splits a glob path into its literal (pre-wildcard) prefix, up to the last `/`. */
function extractLiteralPrefix(path: string): string {
  const globIndex = path.search(GLOB_CHARS);
  if (globIndex === -1) return path;
  const upToGlob = path.slice(0, globIndex);
  const lastSlash = upToGlob.lastIndexOf('/');
  return lastSlash === -1 ? '' : upToGlob.slice(0, lastSlash + 1);
}

/** Whether `key` sits directly under `prefix` with no further `/` nesting. */
function isImmediateChild(prefix: string, key: string): boolean {
  return !key.slice(prefix.length).includes('/');
}

/**
 * Standalone document-validation path, independent of the write-time
 * validation gate — a user could write to the backing store directly
 * (bypassing lcp-server entirely), so this endpoint re-checks existing
 * documents on demand. JWT-guarded (human/CLI-facing), unlike
 * `StorageActionsController`'s internal-key-guarded surface.
 */
@ApiTags('storage')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/storage/validate')
export class StorageValidationController {
  constructor(private readonly storage: StorageService) {}

  /**
   * Validates the document(s) at `path` against the same rules enforced at
   * write time. `path` may be a specific object key or a glob pattern
   * (`*`, `?`). A glob matching zero files is still a success (200); a
   * non-glob path naming a specific file or directory that doesn't exist
   * returns 404.
   */
  @ApiOperation({ summary: 'Validate one or more shared-storage documents' })
  @Post()
  @HttpCode(200)
  async validate(
    @Body() body: ValidateSharedDocumentDto,
  ): Promise<ValidateSharedDocumentResponse> {
    const recursive = body.recursive ?? false;
    const paths = await this.resolvePaths(body.path, recursive);

    const validations = await Promise.all(
      paths.map(async (path): Promise<ValidationEntry> => {
        const result = await this.storage.validateExisting(path);
        return { path, ...result };
      }),
    );

    return { query: { path: body.path, recursive }, validations };
  }

  /**
   * Resolves `path` to a concrete list of object keys to validate.
   *
   * Throws 404 only when `path` has no glob characters and asserts a
   * specific file/directory that doesn't exist — a glob matching zero
   * files is a success with an empty `validations` array.
   */
  private async resolvePaths(
    path: string,
    recursive: boolean,
  ): Promise<string[]> {
    if (!GLOB_CHARS.test(path)) {
      const props = await this.storage.getFileProperties(path);
      if (props.exists) return [path];

      const prefix = path.endsWith('/') ? path : `${path}/`;
      const entries = await this.storage.listFiles(prefix);
      const scoped = this.scopeToRecursion(entries, prefix, recursive);
      if (scoped.length === 0) {
        throw new NotFoundException(`Not found: ${path}`);
      }
      return scoped.map((e) => e.key);
    }

    const prefix = extractLiteralPrefix(path);
    const entries = await this.storage.searchFiles(prefix, path);
    return this.scopeToRecursion(entries, prefix, recursive).map((e) => e.key);
  }

  private scopeToRecursion(
    entries: StorageObject[],
    prefix: string,
    recursive: boolean,
  ): StorageObject[] {
    return recursive
      ? entries
      : entries.filter((e) => isImmediateChild(prefix, e.key));
  }
}
