import { NotFoundException } from '@nestjs/common';
import type { StorageService } from '../storage/storage.service';
import { StorageValidationController } from './storage-validation.controller';

function makeStorage(): jest.Mocked<
  Pick<
    StorageService,
    'getFileProperties' | 'listFiles' | 'searchFiles' | 'validateExisting'
  >
> {
  return {
    getFileProperties: jest.fn(),
    listFiles: jest.fn(),
    searchFiles: jest.fn(),
    validateExisting: jest.fn(),
  };
}

describe('StorageValidationController', () => {
  let storage: ReturnType<typeof makeStorage>;
  let ctrl: StorageValidationController;

  beforeEach(() => {
    storage = makeStorage();
    ctrl = new StorageValidationController(
      storage as unknown as StorageService,
    );
  });

  it('validates a single existing file directly', async () => {
    storage.getFileProperties.mockResolvedValue({
      key: 'acme/a.json',
      exists: true,
    });
    storage.validateExisting.mockResolvedValue({
      found: true,
      size: 10,
      valid: true,
      errors: [],
    });
    const result = await ctrl.validate({ path: 'acme/a.json' });
    expect(result).toEqual({
      query: { path: 'acme/a.json', recursive: false },
      validations: [
        { path: 'acme/a.json', found: true, size: 10, valid: true, errors: [] },
      ],
    });
  });

  it('throws NotFoundException for a specific missing file with no glob chars', async () => {
    storage.getFileProperties.mockResolvedValue({
      key: 'acme/missing.json',
      exists: false,
    });
    storage.listFiles.mockResolvedValue([]);
    await expect(
      ctrl.validate({ path: 'acme/missing.json' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('treats a non-glob path with no exact match as a directory prefix', async () => {
    storage.getFileProperties.mockResolvedValue({
      key: 'acme/knowledge',
      exists: false,
    });
    storage.listFiles.mockResolvedValue([
      {
        key: 'acme/knowledge/a.md',
        name: 'a.md',
        size: 1,
        lastModified: new Date(),
      },
      {
        key: 'acme/knowledge/sub/b.md',
        name: 'b.md',
        size: 1,
        lastModified: new Date(),
      },
    ]);
    storage.validateExisting.mockResolvedValue({
      found: true,
      size: 1,
      valid: true,
      errors: [],
    });
    const result = await ctrl.validate({
      path: 'acme/knowledge',
      recursive: false,
    });
    expect(storage.listFiles).toHaveBeenCalledWith('acme/knowledge/');
    // non-recursive: only the immediate child, not the nested "sub/b.md"
    expect(result.validations).toHaveLength(1);
    expect(result.validations[0].path).toBe('acme/knowledge/a.md');
  });

  it('includes nested entries when recursive is true', async () => {
    storage.getFileProperties.mockResolvedValue({
      key: 'acme/knowledge',
      exists: false,
    });
    storage.listFiles.mockResolvedValue([
      {
        key: 'acme/knowledge/a.md',
        name: 'a.md',
        size: 1,
        lastModified: new Date(),
      },
      {
        key: 'acme/knowledge/sub/b.md',
        name: 'b.md',
        size: 1,
        lastModified: new Date(),
      },
    ]);
    storage.validateExisting.mockResolvedValue({
      found: true,
      size: 1,
      valid: true,
      errors: [],
    });
    const result = await ctrl.validate({
      path: 'acme/knowledge',
      recursive: true,
    });
    expect(result.validations).toHaveLength(2);
  });

  it('returns a 200 with an empty validations array when a glob matches nothing', async () => {
    storage.searchFiles.mockResolvedValue([]);
    const result = await ctrl.validate({ path: 'acme/knowledge/*.md' });
    expect(result).toEqual({
      query: { path: 'acme/knowledge/*.md', recursive: false },
      validations: [],
    });
  });

  it('validates each file matched by a glob', async () => {
    storage.searchFiles.mockResolvedValue([
      {
        key: 'acme/knowledge/a.md',
        name: 'a.md',
        size: 1,
        lastModified: new Date(),
      },
      {
        key: 'acme/knowledge/b.md',
        name: 'b.md',
        size: 2,
        lastModified: new Date(),
      },
    ]);
    storage.validateExisting.mockImplementation((path: string) =>
      Promise.resolve({
        found: true,
        size: path.endsWith('a.md') ? 1 : 2,
        valid: path.endsWith('a.md'),
        errors: path.endsWith('a.md') ? [] : ['bad'],
      }),
    );
    const result = await ctrl.validate({ path: 'acme/knowledge/*.md' });
    expect(storage.searchFiles).toHaveBeenCalledWith(
      'acme/knowledge/',
      'acme/knowledge/*.md',
    );
    expect(result.validations).toEqual([
      {
        path: 'acme/knowledge/a.md',
        found: true,
        size: 1,
        valid: true,
        errors: [],
      },
      {
        path: 'acme/knowledge/b.md',
        found: true,
        size: 2,
        valid: false,
        errors: ['bad'],
      },
    ]);
  });
});
