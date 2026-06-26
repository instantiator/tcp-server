import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Readable } from 'stream';
import type { Response } from 'express';
import type { MinioService } from '../storage/minio.service';
import { StorageProxyController } from './storage-proxy.controller';

const makeMinio = (): jest.Mocked<
  Pick<MinioService, 'getByKey' | 'putByKey'>
> => ({
  getByKey: jest.fn(),
  putByKey: jest.fn(),
});

const makeRes = (): jest.Mocked<Pick<Response, 'setHeader' | 'pipe'>> & {
  pipe: jest.Mock;
} => {
  const res = { setHeader: jest.fn(), pipe: jest.fn() };
  return res;
};

describe('StorageProxyController', () => {
  let minio: ReturnType<typeof makeMinio>;
  let ctrl: StorageProxyController;

  beforeEach(() => {
    minio = makeMinio();
    ctrl = new StorageProxyController(minio as unknown as MinioService);
  });

  describe('download', () => {
    it('streams the file when the key exists', async () => {
      const stream = new Readable({ read() {} });
      minio.getByKey.mockResolvedValue({
        stream,
        contentType: 'text/markdown',
      });
      const res = makeRes();
      // Simulate stream.pipe
      stream.pipe = jest.fn().mockReturnValue(res);

      await ctrl.download('acme/tasks/report.md', res as unknown as Response);

      expect(minio.getByKey).toHaveBeenCalledWith('acme/tasks/report.md');
      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Type',
        'text/markdown',
      );
      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        'attachment; filename="report.md"',
      );
    });

    it('throws NotFoundException when key does not exist', async () => {
      minio.getByKey.mockResolvedValue(null);
      const res = makeRes();
      await expect(
        ctrl.download('acme/missing.md', res as unknown as Response),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws BadRequestException for path with .. segments', async () => {
      const res = makeRes();
      await expect(
        ctrl.download('../etc/passwd', res as unknown as Response),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws BadRequestException for path starting with /', async () => {
      const res = makeRes();
      await expect(
        ctrl.download('/absolute/path', res as unknown as Response),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws BadRequestException for empty path', async () => {
      const res = makeRes();
      await expect(
        ctrl.download('', res as unknown as Response),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('upload', () => {
    const makeFile = (size = 10): Express.Multer.File =>
      ({
        buffer: Buffer.alloc(size, 'x'),
        mimetype: 'text/markdown',
        originalname: 'report.md',
        size,
      }) as Express.Multer.File;

    it('writes to minio and returns key and size', async () => {
      minio.putByKey.mockResolvedValue(10);
      const result = await ctrl.upload('acme/tasks/report.md', makeFile());
      expect(minio.putByKey).toHaveBeenCalledWith(
        'acme/tasks/report.md',
        expect.any(Buffer) as Buffer,
        'text/markdown',
      );
      expect(result).toEqual({ key: 'acme/tasks/report.md', size: 10 });
    });

    it('throws BadRequestException for path with .. segments', async () => {
      await expect(
        ctrl.upload('../evil/path', makeFile()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
