import { DEFAULT_EMBEDDING_DIMENSION } from '@tcp/shared/config/defaults';
import { configSchema } from './config.schema';

describe('configSchema EMBEDDING_DIMENSION', () => {
  const dimension = configSchema.extract('EMBEDDING_DIMENSION');

  // docker-compose.yml passes an unset variable as '' (`${VAR:-}`).
  it('treats an empty value as unset', () => {
    expect(dimension.validate('')).toEqual({
      value: DEFAULT_EMBEDDING_DIMENSION,
    });
  });

  it('accepts a configured width', () => {
    expect(dimension.validate('1536').value).toBe(1536);
  });
});
