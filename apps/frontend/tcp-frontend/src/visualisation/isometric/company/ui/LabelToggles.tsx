import {
  CheckboxButton,
  CheckboxField,
  CheckboxGroup,
  Label,
} from 'react-aria-components';
import { t } from '../../../../strings';
import { LABEL_KINDS, type LabelKind, type LabelToggles } from './officeLabels';

export interface LabelTogglesProps {
  readonly value: LabelToggles;
  readonly onChange: (value: LabelToggles) => void;
}

const isLabelKind = (value: string): value is LabelKind =>
  (LABEL_KINDS as readonly string[]).includes(value);

/**
 * One checkbox per kind of canvas label. The labels repeat what the details
 * picker and the tray already give a screen reader, so they are a visual
 * aid only. `CheckboxField` + `CheckboxButton`, as in `ChatsList.tsx`.
 *
 * Floats over the top-left of the stage (005.01), on its own `.tcp-floating`
 * surface above the toolbar's — same reasoning as there, since this also
 * renders before the stage in the DOM.
 */
export const LabelTogglesControl = ({ value, onChange }: LabelTogglesProps) => (
  <CheckboxGroup
    className="react-aria-CheckboxGroup tcp-floating company-visualisation__labels"
    value={[...value]}
    onChange={(next) => {
      onChange(next.filter(isLabelKind));
    }}
  >
    <Label>{t('visualisation.labels.label')}</Label>
    {LABEL_KINDS.map((kind) => (
      <CheckboxField key={kind} value={kind}>
        <CheckboxButton>{t(`visualisation.labels.${kind}`)}</CheckboxButton>
      </CheckboxField>
    ))}
  </CheckboxGroup>
);
