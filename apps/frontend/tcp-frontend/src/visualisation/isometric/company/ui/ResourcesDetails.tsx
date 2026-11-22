import { t } from '../../../../strings';
import { TrayPanel } from './TrayPanel';

export interface ResourcesDetailsProps {
  readonly companyId: string;
  readonly headingId: string;
  /** Where dialogs, menus and tooltips open, to stay inside full screen. */
  readonly portalContainer?: Element | undefined;
}

/**
 * The plan chest's tray: the company's resource folders. The body is empty
 * until the folder list lands.
 */
export const ResourcesDetails = ({ headingId }: ResourcesDetailsProps) => (
  <TrayPanel
    headingId={headingId}
    heading={t('visualisation.resources.heading')}
  />
);
