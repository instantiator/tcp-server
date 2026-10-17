import type { RefObject } from 'react';
import {
  ComboBox,
  FieldError,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Text,
  useFilter,
} from 'react-aria-components';
import { TIME_ZONES } from './timeZones';

export interface TimezoneFieldProps {
  /** Already resolved through `t`. */
  readonly label: string;
  /** The zone as typed; `''` means none. */
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Already resolved through `t`. */
  readonly description?: string;
  /** Already resolved through `t`. */
  readonly errorMessage?: string;
  /** So a failed submit can move focus here, as `TextField` allows. */
  readonly inputRef?: RefObject<HTMLElement | null>;
}

/**
 * A time zone picker: type to filter the IANA zones, or pick one.
 *
 * The typed text is the value, as in the model picker's ComboBox, so a form
 * can hold it as a string and clear it. The host checks it with
 * `isKnownTimeZone` (`timeZones.ts`) on save; the server validates it again.
 */
export const TimezoneField = ({
  label,
  value,
  onChange,
  description,
  errorMessage,
  inputRef,
}: TimezoneFieldProps) => {
  const { contains } = useFilter({ sensitivity: 'base' });
  return (
    <ComboBox
      className="react-aria-ComboBox tcp-field"
      allowsCustomValue
      defaultItems={TIME_ZONES.map((id) => ({ id }))}
      defaultFilter={contains}
      inputValue={value}
      onInputChange={onChange}
      isInvalid={errorMessage !== undefined}
      validationBehavior="aria"
    >
      <Label className="react-aria-Label tcp-field__label">{label}</Label>
      <Input
        className="react-aria-Input"
        ref={(node) => {
          if (inputRef !== undefined) inputRef.current = node;
        }}
      />
      {description !== undefined && (
        <Text slot="description" className="react-aria-Text tcp-field__hint">
          {description}
        </Text>
      )}
      {errorMessage !== undefined && (
        <FieldError className="react-aria-FieldError tcp-field__error">
          {errorMessage}
        </FieldError>
      )}
      <Popover>
        <ListBox<{ id: string }>>
          {(zone) => <ListBoxItem id={zone.id}>{zone.id}</ListBoxItem>}
        </ListBox>
      </Popover>
    </ComboBox>
  );
};
