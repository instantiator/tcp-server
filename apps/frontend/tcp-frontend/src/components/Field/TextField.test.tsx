import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { Button } from 'react-aria-components';
import { describe, expect, it } from 'vitest';

import { expectNoA11yViolations } from '../../test-support/axe';

import { focusFirstInvalid } from './focusFirstInvalid';
import { TextField } from './TextField';

/**
 * A controlled wrapper, because the field is controlled and a test that never
 * updates `value` cannot type into it.
 */
const Harness = ({
  label = 'Your answer',
  errorMessage,
  description,
  multiline = false,
}: {
  readonly label?: string;
  readonly errorMessage?: string;
  readonly description?: string;
  readonly multiline?: boolean;
}) => {
  const [value, setValue] = useState('');
  return (
    <TextField
      label={label}
      value={value}
      onChange={setValue}
      errorMessage={errorMessage}
      description={description}
      multiline={multiline}
    />
  );
};

describe('TextField', () => {
  it('is found by its label', () => {
    render(<Harness label="Your answer" />);

    expect(screen.getByRole('textbox', { name: 'Your answer' })).toBeVisible();
  });

  it('is still a textbox when multiline', () => {
    render(<Harness label="Your answer" multiline />);

    expect(screen.getByRole('textbox', { name: 'Your answer' }).tagName).toBe(
      'TEXTAREA',
    );
  });

  it('accepts typing', async () => {
    const user = userEvent.setup();
    render(<Harness label="Your answer" />);

    await user.type(screen.getByRole('textbox', { name: 'Your answer' }), 'hi');

    expect(screen.getByRole('textbox', { name: 'Your answer' })).toHaveValue(
      'hi',
    );
  });

  // The point of the component. Text merely rendered near the field would pass
  // a "the message is on screen" assertion and tell a screen reader user
  // nothing about which field is wrong.
  it('associates an error message with the field', () => {
    render(<Harness label="Your answer" errorMessage="Type an answer." />);

    const field = screen.getByRole('textbox', { name: 'Your answer' });
    expect(field).toHaveAccessibleDescription('Type an answer.');
    expect(field).toBeInvalid();
  });

  it('associates a description with the field', () => {
    render(<Harness label="Your answer" description="Anything you like." />);

    expect(
      screen.getByRole('textbox', { name: 'Your answer' }),
    ).toHaveAccessibleDescription('Anything you like.');
  });

  it('is neither invalid nor described when no error is set', () => {
    render(<Harness label="Your answer" />);

    const field = screen.getByRole('textbox', { name: 'Your answer' });
    expect(field).not.toBeInvalid();
    expect(field).toHaveAccessibleDescription('');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<Harness label="Your answer" />);

    await expectNoA11yViolations(container);
  });

  it('has no accessibility violations while showing an error', async () => {
    const { container } = render(
      <Harness
        label="Your answer"
        errorMessage="Type an answer."
        description="Anything you like."
      />,
    );

    await expectNoA11yViolations(container);
  });
});

describe('focusFirstInvalid', () => {
  const TwoFields = () => {
    const first = useRef<HTMLElement | null>(null);
    const second = useRef<HTMLElement | null>(null);
    const [firstError, setFirstError] = useState<string | undefined>(undefined);
    const [secondError, setSecondError] = useState<string | undefined>(
      undefined,
    );
    const [first_, setFirst] = useState('');
    const [second_, setSecond] = useState('');

    return (
      <>
        <TextField
          label="First"
          value={first_}
          onChange={setFirst}
          errorMessage={firstError}
          inputRef={first}
        />
        <TextField
          label="Second"
          value={second_}
          onChange={setSecond}
          errorMessage={secondError}
          inputRef={second}
        />
        <Button
          className="react-aria-Button"
          onPress={() => {
            setSecondError('Wrong.');
            focusFirstInvalid([
              { error: undefined, ref: first },
              { error: 'Wrong.', ref: second },
            ]);
          }}
        >
          Fail second
        </Button>
        <Button
          className="react-aria-Button"
          onPress={() => {
            setFirstError('Wrong.');
            focusFirstInvalid([
              { error: 'Wrong.', ref: first },
              { error: 'Wrong.', ref: second },
            ]);
          }}
        >
          Fail both
        </Button>
      </>
    );
  };

  it('skips valid fields and focuses the first invalid one', async () => {
    const user = userEvent.setup();
    render(<TwoFields />);

    await user.click(screen.getByRole('button', { name: 'Fail second' }));

    expect(document.activeElement).toBe(
      screen.getByRole('textbox', { name: 'Second' }),
    );
  });

  it('focuses the first of several invalid fields', async () => {
    const user = userEvent.setup();
    render(<TwoFields />);

    await user.click(screen.getByRole('button', { name: 'Fail both' }));

    expect(document.activeElement).toBe(
      screen.getByRole('textbox', { name: 'First' }),
    );
  });

  it('does nothing when every field is valid', () => {
    const orphan = { current: null };

    expect(() => {
      focusFirstInvalid([{ error: undefined, ref: orphan }]);
    }).not.toThrow();
  });
});
