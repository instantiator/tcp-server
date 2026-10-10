import type { ReactNode } from 'react';
import './LabelledValue.css';

export interface LabelledValueProps {
  /** The field's name, already resolved through `t`. */
  readonly label: string;
  readonly children: ReactNode;
}

/** A read-only labelled value, with the label above it ("Request", then the request). */
export const LabelledValue = ({ label, children }: LabelledValueProps) => (
  <p className="tcp-labelled-value">
    <span className="tcp-labelled-value__label">{label}</span>
    {children}
  </p>
);
