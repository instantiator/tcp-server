import type { RefObject } from 'react';
import {
  FieldError,
  Input,
  Label,
  Text,
  TextArea,
  TextField as AriaTextField,
} from 'react-aria-components';

import './TextField.css';

export interface TextFieldProps {
  /** The visible label, which is also the field's accessible name. Already resolved through `t`. */
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  /**
   * The problem with what has been typed. Setting it marks the field invalid
   * and associates the text with the field, so a screen reader user hears
   * which field is wrong rather than a message floating on its own. Already
   * resolved through `t`.
   */
  readonly errorMessage?: string;
  /** Standing help text, not an error. Already resolved through `t`. */
  readonly description?: string;
  readonly isRequired?: boolean;
  readonly isDisabled?: boolean;
  /** Renders a `TextArea` rather than a single-line `Input`. */
  readonly multiline?: boolean;
  /** So a failed submit can move focus to the first field that is wrong. */
  readonly inputRef?: RefObject<HTMLElement | null>;
}

/**
 * A labelled text field whose error message is associated with it.
 *
 * The application's first form control, and the reason it exists rather than
 * each form writing its own: an error message that is merely *near* a field
 * tells a sighted user which one is wrong and tells a screen reader user
 * nothing. React Aria wires `aria-describedby` and `aria-invalid` from
 * `isInvalid` plus a `FieldError` child, so the association comes from the
 * library rather than from attributes we would have to remember on every form.
 *
 * **`validationBehavior` is `aria`, not the default `native`.** Native
 * validation would put `required` on the element, and the browser would then
 * refuse the submit with a bubble of its own before our handler ran — which
 * takes away both our wording and our control over where focus lands. `aria`
 * marks the field required for assistive technology and leaves the submit to
 * us.
 *
 * `inputRef` is a callback assignment rather than a forwarded ref because the
 * element is an `input` or a `textarea` depending on `multiline`, and one
 * `RefObject<HTMLElement | null>` covers both without a cast.
 */
export const TextField = ({
  label,
  value,
  onChange,
  errorMessage,
  description,
  isRequired = false,
  isDisabled = false,
  multiline = false,
  inputRef,
}: TextFieldProps) => {
  // React Aria replaces its own default class when `className` is passed, and
  // `base.css` styles these components through those defaults — so every one
  // is repeated alongside the block class here.
  const assignRef = (node: HTMLElement | null): void => {
    if (inputRef !== undefined) inputRef.current = node;
  };

  return (
    <AriaTextField
      className="react-aria-TextField tcp-field"
      value={value}
      onChange={onChange}
      isRequired={isRequired}
      isDisabled={isDisabled}
      isInvalid={errorMessage !== undefined}
      validationBehavior="aria"
    >
      <Label className="react-aria-Label tcp-field__label">{label}</Label>
      {multiline ? (
        <TextArea className="react-aria-TextArea" ref={assignRef} />
      ) : (
        <Input className="react-aria-Input" ref={assignRef} />
      )}
      {description !== undefined && (
        <Text slot="description" className="react-aria-Text tcp-field__hint">
          {description}
        </Text>
      )}
      {/*
        Explicit children rather than a render function. React Aria's default
        is the browser's own validation string, which is neither our wording
        nor translated.
      */}
      {errorMessage !== undefined && (
        <FieldError className="react-aria-FieldError tcp-field__error">
          {errorMessage}
        </FieldError>
      )}
    </AriaTextField>
  );
};
