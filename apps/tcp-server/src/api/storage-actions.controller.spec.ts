import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { StorageService } from '../storage/storage.service';
import { StorageActionsController } from './storage-actions.controller';

function makeStorage(): jest.Mocked<
  Pick<
    StorageService,
    | 'listFiles'
    | 'readFile'
    | 'writeFile'
    | 'deleteFile'
    | 'restoreFile'
    | 'searchFiles'
    | 'getFileProperties'
    | 'copyFile'
    | 'moveFile'
    | 'getFileSummary'
    | 'checkMissingFiles'
  >
> {
  return {
    listFiles: jest.fn(),
    readFile: jest.fn(),
    writeFile: jest.fn(),
    deleteFile: jest.fn(),
    restoreFile: jest.fn(),
    searchFiles: jest.fn(),
    getFileProperties: jest.fn(),
    copyFile: jest.fn(),
    moveFile: jest.fn(),
    getFileSummary: jest.fn(),
    checkMissingFiles: jest.fn(),
  };
}

describe('StorageActionsController', () => {
  let storage: ReturnType<typeof makeStorage>;
  let ctrl: StorageActionsController;

  beforeEach(() => {
    storage = makeStorage();
    ctrl = new StorageActionsController(storage as unknown as StorageService);
  });

  it('list wraps listFiles results in { entries }', async () => {
    storage.listFiles.mockResolvedValue([
      { key: 'a', name: 'a', size: 1, lastModified: new Date() },
    ]);
    const result = await ctrl.list({ prefix: 'acme' });
    expect(storage.listFiles).toHaveBeenCalledWith('acme');
    expect(result.entries).toHaveLength(1);
  });

  it('read returns { content } for an existing file', async () => {
    storage.readFile.mockResolvedValue('hello');
    const result = await ctrl.read({ path: 'acme/a.txt' });
    expect(result).toEqual({ content: 'hello' });
  });

  it('read throws NotFoundException when the file does not exist', async () => {
    storage.readFile.mockResolvedValue(null);
    await expect(
      ctrl.read({ path: 'acme/missing.txt' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('write normalises originators before delegating', async () => {
    storage.writeFile.mockResolvedValue({ key: 'acme/a.txt', size: 5 });
    const result = await ctrl.write({
      path: 'acme/a.txt',
      content: 'hello',
      overwrite: true,
      originators: { user: 'user-1' },
    });
    expect(storage.writeFile).toHaveBeenCalledWith(
      'acme/a.txt',
      'hello',
      true,
      {
        user: 'user-1',
        agent: null,
        task: null,
      },
    );
    expect(result).toEqual({ key: 'acme/a.txt', size: 5 });
  });

  it('write propagates validation failures thrown by the storage layer', async () => {
    const err = new Error('invalid');
    storage.writeFile.mockRejectedValue(err);
    await expect(
      ctrl.write({ path: 'acme/a.json', content: '{bad' }),
    ).rejects.toThrow(err);
  });

  it('delete returns { restorable: true }', async () => {
    storage.deleteFile.mockResolvedValue(undefined);
    const result = await ctrl.delete({ path: 'acme/a.txt' });
    expect(result).toEqual({ restorable: true });
  });

  it('restore returns { restored: true }', async () => {
    storage.restoreFile.mockResolvedValue(undefined);
    const result = await ctrl.restore({ path: 'acme/a.txt' });
    expect(result).toEqual({ restored: true });
  });

  describe('append', () => {
    it('creates the file when absent (created: true) and validates the result', async () => {
      storage.readFile.mockResolvedValue(null);
      storage.writeFile.mockResolvedValue({ key: 'acme/a.md', size: 4 });
      const result = await ctrl.append({
        path: 'acme/a.md',
        content: 'new!',
        originators: { agent: 'agent-1' },
      });
      expect(storage.writeFile).toHaveBeenCalledWith(
        'acme/a.md',
        'new!',
        true,
        {
          user: null,
          agent: 'agent-1',
          task: null,
        },
      );
      expect(result).toEqual({ key: 'acme/a.md', size: 4, created: true });
    });

    it('appends to existing content (created: false)', async () => {
      storage.readFile.mockResolvedValue('one\n');
      storage.writeFile.mockResolvedValue({ key: 'acme/a.md', size: 8 });
      const result = await ctrl.append({ path: 'acme/a.md', content: 'two\n' });
      expect(storage.writeFile).toHaveBeenCalledWith(
        'acme/a.md',
        'one\ntwo\n',
        true,
        undefined,
      );
      expect(result.created).toBe(false);
    });

    it('propagates a validation failure from the resulting write', async () => {
      storage.readFile.mockResolvedValue('{');
      const err = new Error('invalid');
      storage.writeFile.mockRejectedValue(err);
      await expect(
        ctrl.append({ path: 'acme/a.json', content: 'bad' }),
      ).rejects.toThrow(err);
    });
  });

  describe('replace', () => {
    it('replaces all occurrences and returns the count', async () => {
      storage.readFile.mockResolvedValue('foo foo bar foo');
      storage.writeFile.mockResolvedValue({ key: 'acme/a.md', size: 15 });
      const result = await ctrl.replace({
        path: 'acme/a.md',
        find: 'foo',
        replace: 'baz',
      });
      expect(storage.writeFile).toHaveBeenCalledWith(
        'acme/a.md',
        'baz baz bar baz',
        true,
        undefined,
      );
      expect(result).toEqual({ key: 'acme/a.md', count: 3 });
    });

    it('throws NotFoundException when the file is missing', async () => {
      storage.readFile.mockResolvedValue(null);
      await expect(
        ctrl.replace({ path: 'acme/missing.md', find: 'a', replace: 'b' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws BadRequestException when the string is not found', async () => {
      storage.readFile.mockResolvedValue('no match here');
      await expect(
        ctrl.replace({ path: 'acme/a.md', find: 'zzz', replace: 'b' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.writeFile).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when find is empty', async () => {
      await expect(
        ctrl.replace({ path: 'acme/a.md', find: '', replace: 'b' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.readFile).not.toHaveBeenCalled();
    });
  });

  it('search wraps searchFiles results in { entries }', async () => {
    storage.searchFiles.mockResolvedValue([]);
    const result = await ctrl.search({ prefix: 'acme', pattern: '*.md' });
    expect(storage.searchFiles).toHaveBeenCalledWith('acme', '*.md');
    expect(result).toEqual({ entries: [] });
  });

  it('properties returns the storage layer result directly', async () => {
    storage.getFileProperties.mockResolvedValue({
      key: 'acme/a.txt',
      exists: true,
    });
    const result = await ctrl.properties({ path: 'acme/a.txt' });
    expect(result).toEqual({ key: 'acme/a.txt', exists: true });
  });

  it('copy returns { copied: true }', async () => {
    storage.copyFile.mockResolvedValue(undefined);
    const result = await ctrl.copy({
      source: 'acme/a.txt',
      destination: 'acme/b.txt',
    });
    expect(result).toEqual({ copied: true });
  });

  it('move returns { moved: true }', async () => {
    storage.moveFile.mockResolvedValue(undefined);
    const result = await ctrl.move({
      source: 'acme/a.txt',
      destination: 'acme/b.txt',
    });
    expect(result).toEqual({ moved: true });
  });

  it('summary returns the storage layer result directly', async () => {
    storage.getFileSummary.mockResolvedValue({ format: 'json-object' });
    const result = await ctrl.summary({ path: 'acme/a.json' });
    expect(result).toEqual({ format: 'json-object' });
  });

  it('exists returns { missing } for a single path', async () => {
    storage.checkMissingFiles.mockResolvedValue(['acme/missing.txt']);
    const result = await ctrl.exists('acme/missing.txt');
    expect(storage.checkMissingFiles).toHaveBeenCalledWith([
      'acme/missing.txt',
    ]);
    expect(result).toEqual({ missing: ['acme/missing.txt'] });
  });

  it('exists returns { missing: [] } when no paths are given', async () => {
    storage.checkMissingFiles.mockResolvedValue([]);
    const result = await ctrl.exists(undefined);
    expect(storage.checkMissingFiles).toHaveBeenCalledWith([]);
    expect(result).toEqual({ missing: [] });
  });
});
