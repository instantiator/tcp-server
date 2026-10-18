import { apiRequest } from '../core/api';
import { resolveToken } from '../auth/token';
import {
  addTemplateSourceAction,
  removeTemplateSourceAction,
} from './template-gallery.action';

jest.mock('../core/api');
jest.mock('../auth/token');

const opts = { tcpServer: 'http://localhost:3000' };

describe('template source actions', () => {
  let stdoutSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(resolveToken).mockResolvedValue('token');
    stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => stdoutSpy.mockRestore());

  it('adds a source, sending ref and path only when given', async () => {
    await addTemplateSourceAction(opts, 'Mine', 'o/r', { ref: 'dev' });

    expect(apiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'POST',
      '/api/template-source',
      { name: 'Mine', repo: 'o/r', ref: 'dev' },
    );
  });

  it('removes a source by id', async () => {
    await removeTemplateSourceAction(opts, 'abc');

    expect(apiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'DELETE',
      '/api/template-source/abc',
      undefined,
    );
  });
});
