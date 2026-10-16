import { apiRequest } from '../core/api';
import { resolveToken } from '../auth/token';
import { alterRequest, alterTableAction } from './alter-table.action';

jest.mock('../core/api');
jest.mock('../auth/token');

const mockedApiRequest = jest.mocked(apiRequest);
const mockedResolveToken = jest.mocked(resolveToken);

const base = { companyId: 'c1', table: 'orders' };

describe('alterRequest', () => {
  it('maps add-column to a POST, parsing a JSON default', () => {
    expect(
      alterRequest({
        ...base,
        op: 'add-column',
        column: 'qty',
        type: 'integer',
        default: '1',
        required: true,
      }),
    ).toEqual({
      method: 'POST',
      path: '/columns',
      body: {
        column: 'qty',
        type: 'integer',
        format: undefined,
        description: undefined,
        default: 1,
        required: true,
      },
    });
  });

  it.each([
    ['true', true],
    ['"x"', 'x'],
    ['plain text', 'plain text'],
  ])('reads the default %s as %p', (text, value) => {
    const req = alterRequest({
      ...base,
      op: 'add-column',
      column: 'c',
      type: 'string',
      default: text,
    });
    expect(req.body).toMatchObject({ default: value });
  });

  it('maps rename-column to a PATCH, encoding the column', () => {
    expect(
      alterRequest({
        ...base,
        op: 'rename-column',
        column: 'a/b',
        newName: 'c',
      }),
    ).toEqual({
      method: 'PATCH',
      path: '/columns/a%2Fb',
      body: { newName: 'c' },
    });
  });

  it('maps delete-column to a DELETE, only with --yes', () => {
    const del = { ...base, op: 'delete-column', column: 'note' };
    expect(() => alterRequest(del)).toThrow('--yes');
    expect(alterRequest({ ...del, yes: true })).toEqual({
      method: 'DELETE',
      path: '/columns/note',
    });
  });

  it('maps set-key to a PUT of the comma-separated fields', () => {
    expect(alterRequest({ ...base, op: 'set-key', fields: 'a, b' })).toEqual({
      method: 'PUT',
      path: '/primary-key',
      body: { fields: ['a', 'b'] },
    });
  });

  it('maps add-unique-key to a POST of the fields', () => {
    expect(
      alterRequest({ ...base, op: 'add-unique-key', fields: 'a, b' }),
    ).toEqual({
      method: 'POST',
      path: '/unique-keys',
      body: { fields: ['a', 'b'] },
    });
  });

  it('maps drop-unique-key to a DELETE naming the encoded fields', () => {
    expect(
      alterRequest({ ...base, op: 'drop-unique-key', fields: 'a, b' }),
    ).toEqual({ method: 'DELETE', path: '/unique-keys/a%2Cb' });
  });

  it('maps retype-column to a PUT, blanking only with the flag and --yes', () => {
    const retype = {
      ...base,
      op: 'retype-column',
      column: 'qty',
      type: 'integer',
    };
    expect(alterRequest(retype)).toEqual({
      method: 'PUT',
      path: '/columns/qty/type',
      body: { type: 'integer', format: undefined },
      query: {},
    });
    expect(() => alterRequest({ ...retype, blankUnconvertible: true })).toThrow(
      '--yes',
    );
    expect(
      alterRequest({ ...retype, blankUnconvertible: true, yes: true }).query,
    ).toEqual({ blankUnconvertible: 'true' });
  });

  it.each([
    [{ op: 'add-unique-key' }, '--fields'],
    [{ op: 'drop-unique-key' }, '--fields'],
    [{ op: 'retype-column', type: 'string' }, '--column'],
    [{ op: 'retype-column', column: 'c' }, '--type'],
    [{ op: 'add-column', type: 'string' }, '--column'],
    [{ op: 'add-column', column: 'c' }, '--type'],
    [{ op: 'rename-column', column: 'c' }, '--new-name'],
    [{ op: 'rename-column', newName: 'c' }, '--column'],
    [{ op: 'delete-column', yes: true }, '--column'],
    [{ op: 'set-key' }, '--fields'],
    [{ op: 'explode' }, 'Unknown change'],
  ])('names what %j lacks', (partial, message) => {
    expect(() => alterRequest({ ...base, ...partial })).toThrow(message);
  });
});

describe('alterTableAction', () => {
  let stdoutSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveToken.mockResolvedValue('token');
    mockedApiRequest.mockResolvedValue({ name: 'orders' });
    stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => stdoutSpy.mockRestore());

  it('sends the request to the table and prints the definition', async () => {
    await alterTableAction(
      { tcpServer: 'http://localhost:3000' },
      {
        ...base,
        table: 'my orders',
        op: 'set-key',
        fields: 'a',
        confirmDoNotStore: true,
      },
    );

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'PUT',
      '/api/company/c1/records/tables/my%20orders/primary-key?confirmDoNotStore=true',
      { fields: ['a'] },
    );
    expect(stdoutSpy).toHaveBeenCalledWith('{\n  "name": "orders"\n}\n');
  });

  it("combines the operation's query with the confirmation", async () => {
    await alterTableAction(
      { tcpServer: 'http://localhost:3000' },
      {
        ...base,
        op: 'retype-column',
        column: 'qty',
        type: 'integer',
        blankUnconvertible: true,
        yes: true,
        confirmDoNotStore: true,
      },
    );

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'PUT',
      '/api/company/c1/records/tables/orders/columns/qty/type?blankUnconvertible=true&confirmDoNotStore=true',
      { type: 'integer', format: undefined },
    );
  });
});
