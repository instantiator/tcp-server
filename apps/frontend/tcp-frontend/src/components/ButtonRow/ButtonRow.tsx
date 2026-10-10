import type { ReactNode } from 'react';
import './ButtonRow.css';

/**
 * Buttons (and button-like links) side by side, always with space between
 * them and wrapping onto the next line when there's no room. Use it wherever
 * more than one control sits in a row, so none ever touch.
 */
export const ButtonRow = ({ children }: { readonly children: ReactNode }) => (
  <div className="tcp-button-row">{children}</div>
);
