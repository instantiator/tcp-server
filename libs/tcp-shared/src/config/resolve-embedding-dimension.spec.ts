import { DataSource } from 'typeorm';
import {
  getConfiguredDimension,
  getActualDimension,
  checkEmbeddingDimension,
  DEFAULT_EMBEDDING_DIMENSION,
} from './resolve-embedding-dimension';

describe('resolve-embedding-dimension', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('getConfiguredDimension', () => {
    it('returns default when EMBEDDING_DIMENSION is not set', () => {
      delete process.env.EMBEDDING_DIMENSION;
      expect(getConfiguredDimension()).toBe(DEFAULT_EMBEDDING_DIMENSION);
    });

    it('returns configured value when set', () => {
      process.env.EMBEDDING_DIMENSION = '1024';
      expect(getConfiguredDimension()).toBe(1024);
    });

    it('returns default for invalid values', () => {
      process.env.EMBEDDING_DIMENSION = 'not-a-number';
      expect(getConfiguredDimension()).toBe(DEFAULT_EMBEDDING_DIMENSION);
    });

    it('returns default for zero or negative values', () => {
      process.env.EMBEDDING_DIMENSION = '0';
      expect(getConfiguredDimension()).toBe(DEFAULT_EMBEDDING_DIMENSION);
      process.env.EMBEDDING_DIMENSION = '-1';
      expect(getConfiguredDimension()).toBe(DEFAULT_EMBEDDING_DIMENSION);
    });
  });

  describe('getActualDimension', () => {
    it('returns null when table does not exist', async () => {
      const mockDataSource = {
        query: jest
          .fn()
          .mockRejectedValue(
            new Error('relation "knowledge_chunks" does not exist'),
          ),
      } as unknown as DataSource;
      expect(await getActualDimension(mockDataSource)).toBeNull();
    });

    it('returns null when embedding column does not exist', async () => {
      const mockDataSource = {
        query: jest.fn().mockResolvedValue([]),
      } as unknown as DataSource;
      expect(await getActualDimension(mockDataSource)).toBeNull();
    });

    it('returns dimension when column exists', async () => {
      const mockDataSource = {
        query: jest.fn().mockResolvedValue([{ atttypmod: 776 }]), // 768 + 8
      } as unknown as DataSource;
      expect(await getActualDimension(mockDataSource)).toBe(768);
    });
  });

  describe('checkEmbeddingDimension', () => {
    it('returns false when dimensions match', async () => {
      process.env.EMBEDDING_DIMENSION = '768';
      const mockDataSource = {
        query: jest.fn().mockResolvedValue([{ atttypmod: 776 }]),
      } as unknown as DataSource;
      const result = await checkEmbeddingDimension(mockDataSource);
      expect(result.migrationNeeded).toBe(false);
      expect(result.configuredDimension).toBe(768);
      expect(result.actualDimension).toBe(768);
    });

    it('returns true when dimensions differ', async () => {
      process.env.EMBEDDING_DIMENSION = '1024';
      const mockDataSource = {
        query: jest.fn().mockResolvedValue([{ atttypmod: 776 }]),
      } as unknown as DataSource;
      const result = await checkEmbeddingDimension(mockDataSource);
      expect(result.migrationNeeded).toBe(true);
      expect(result.configuredDimension).toBe(1024);
      expect(result.actualDimension).toBe(768);
    });

    it('returns false when table does not exist', async () => {
      process.env.EMBEDDING_DIMENSION = '768';
      const mockDataSource = {
        query: jest
          .fn()
          .mockRejectedValue(new Error('relation does not exist')),
      } as unknown as DataSource;
      const result = await checkEmbeddingDimension(mockDataSource);
      expect(result.migrationNeeded).toBe(false);
      expect(result.actualDimension).toBeNull();
    });
  });
});
