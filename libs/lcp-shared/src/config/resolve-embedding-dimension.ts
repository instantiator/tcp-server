import { DataSource } from 'typeorm';

/**
 * Default embedding dimension used when EMBEDDING_DIMENSION env var is not set.
 * Must match the default in the Joi config schemas.
 */
export const DEFAULT_EMBEDDING_DIMENSION = 768;

/**
 * Result of checking whether an embedding dimension migration is needed.
 */
export interface EmbeddingDimensionCheck {
  /** The configured dimension from environment. */
  configuredDimension: number;
  /** The actual dimension in the database column, or null if table doesn't exist. */
  actualDimension: number | null;
  /** Whether a migration is needed to change the column width. */
  migrationNeeded: boolean;
}

/**
 * Reads the configured embedding dimension from environment.
 * Falls back to {@link DEFAULT_EMBEDDING_DIMENSION} if not set.
 */
export function getConfiguredDimension(): number {
  const raw = process.env.EMBEDDING_DIMENSION;
  if (!raw) return DEFAULT_EMBEDDING_DIMENSION;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed < 1) return DEFAULT_EMBEDDING_DIMENSION;
  return parsed;
}

/**
 * Queries the database for the actual vector column width.
 * Returns null if the knowledge_chunks table doesn't exist.
 */
export async function getActualDimension(
  dataSource: DataSource,
): Promise<number | null> {
  try {
    const result: Array<{ atttypmod: number | null }> = await dataSource.query(`
        SELECT atttypmod
        FROM pg_attribute
        WHERE attrelid = 'knowledge_chunks'::regclass
          AND attname = 'embedding'
      `);
    if (result.length === 0 || !result[0].atttypmod) return null;
    // atttypmod for vector type stores the dimension + 8 bytes overhead
    return result[0].atttypmod - 8;
  } catch {
    return null;
  }
}

/**
 * Checks whether an embedding dimension migration is needed by comparing
 * the configured dimension against the actual database column width.
 */
export async function checkEmbeddingDimension(
  dataSource: DataSource,
): Promise<EmbeddingDimensionCheck> {
  const configuredDimension = getConfiguredDimension();
  const actualDimension = await getActualDimension(dataSource);
  const migrationNeeded =
    actualDimension !== null && actualDimension !== configuredDimension;
  return { configuredDimension, actualDimension, migrationNeeded };
}
