import { buildEnumValidationError } from './enum-validation';

describe('buildEnumValidationError', () => {
  it('names the field, the bad value, and the valid values, with the corrective suffix', () => {
    const msg = buildEnumValidationError('create the plan', [
      {
        property: 'assignment 0 role',
        value: 'Food Researcher',
        validValues: ['chicken-assistant', 'cat-assistant'],
      },
    ]);
    expect(msg).toContain('One value was not valid:');
    expect(msg).toContain('assignment 0 role');
    expect(msg).toContain('"Food Researcher"');
    expect(msg).toContain(
      'Valid values are: chicken-assistant, cat-assistant.',
    );
    expect(msg).toContain(
      'If you still intend to create the plan, try again with corrected values for assignment 0 role.',
    );
  });

  it('reports every invalid value at once and lists them all in the suffix', () => {
    const msg = buildEnumValidationError('create the plan', [
      {
        property: 'assignment 0 role',
        value: 'Food Researcher',
        validValues: ['chicken-assistant'],
      },
      {
        property: 'assignment 0 expected type',
        value: 'inline_text',
        validValues: ['assignment-working-path', 'inline-text'],
      },
    ]);
    expect(msg).toContain('2 values were not valid:');
    // both properties named in the suffix, comma-separated
    expect(msg).toContain(
      'corrected values for assignment 0 role, assignment 0 expected type.',
    );
  });
});
