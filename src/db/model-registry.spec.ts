import { Model } from 'sequelize';
import { RegisterModel, getRegisteredModels } from './model-registry';

describe('getRegisteredModels', () => {
  it('returns an array', () => {
    expect(Array.isArray(getRegisteredModels())).toBe(true);
  });

  it('returns a new array on each call', () => {
    expect(getRegisteredModels()).not.toBe(getRegisteredModels());
  });

  it('mutating the returned array does not affect subsequent calls', () => {
    const first = getRegisteredModels();
    const lengthBefore = first.length;
    first.splice(0, first.length);
    expect(getRegisteredModels().length).toBe(lengthBefore);
  });

  it('each entry has a register method', () => {
    for (const entry of getRegisteredModels()) {
      expect(typeof entry.register).toBe('function');
    }
  });
});

describe('RegisterModel', () => {
  it('adds the decorated class to the registry', () => {
    const before = getRegisteredModels().length;

    @RegisterModel()
    class DummyModel extends Model {
      static register() {}
    }

    const after = getRegisteredModels();
    expect(after.length).toBe(before + 1);
    expect(after).toContain(DummyModel);
  });
});
