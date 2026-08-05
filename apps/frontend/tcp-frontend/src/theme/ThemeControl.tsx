import {
  Label,
  RadioButton,
  RadioField,
  RadioGroup,
} from 'react-aria-components';
import { t } from '../strings';
import type { Mode, Theme } from './storage';
import { useTheme } from './useTheme';
import './ThemeControl.css';

/** Narrows React Aria's `string` back to the stored union, without a cast. */
const asTheme = (value: string): Theme =>
  value === 'high-contrast' ? 'high-contrast' : 'default';

/** Narrows React Aria's `string` back to the stored union, without a cast. */
const asMode = (value: string): Mode => (value === 'dark' ? 'dark' : 'light');

/**
 * The user's explicit theme choice, as the two independent axes ADR-026
 * defines: the palette, and its light or dark variant.
 *
 * Radio groups rather than a menu or a pair of toggles — the choice is one of
 * a small, fully visible set, which is exactly what a radio group states to a
 * screen reader. A toggle would assert a boolean where the model has two
 * named values, and a menu would hide the alternatives behind a popup.
 *
 * `RadioField` + `RadioButton` rather than `Radio`, which React Aria 1.20
 * deprecates. The pair renders the same shape — a label wrapping a visually
 * hidden input — so `styles/base.css` selects on `.react-aria-RadioButton`.
 *
 * Passing `className` to a React Aria component replaces its default class
 * rather than adding to it, so the library's own class name is repeated here
 * — without it every rule in `styles/base.css` stops applying, silently.
 *
 * 003.02's header reuses this component; it is not landing-page-specific.
 */
export const ThemeControl = () => {
  const { theme, mode, setTheme, setMode } = useTheme();

  return (
    <div className="theme-control">
      <RadioGroup
        className="react-aria-RadioGroup theme-control__group"
        value={theme}
        onChange={(value) => {
          setTheme(asTheme(value));
        }}
      >
        <Label>{t('theme.palette.label')}</Label>
        <RadioField value="default">
          <RadioButton>{t('theme.palette.default')}</RadioButton>
        </RadioField>
        <RadioField value="high-contrast">
          <RadioButton>{t('theme.palette.highContrast')}</RadioButton>
        </RadioField>
      </RadioGroup>

      <RadioGroup
        className="react-aria-RadioGroup theme-control__group"
        value={mode}
        onChange={(value) => {
          setMode(asMode(value));
        }}
      >
        <Label>{t('theme.mode.label')}</Label>
        <RadioField value="light">
          <RadioButton>{t('theme.mode.light')}</RadioButton>
        </RadioField>
        <RadioField value="dark">
          <RadioButton>{t('theme.mode.dark')}</RadioButton>
        </RadioField>
      </RadioGroup>
    </div>
  );
};
