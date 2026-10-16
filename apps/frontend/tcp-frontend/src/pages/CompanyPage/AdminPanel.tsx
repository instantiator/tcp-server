import { ListBox, ListBoxItem } from 'react-aria-components';
import { t } from '../../strings';
import {
  ADMIN_SECTIONS,
  isAdminSection,
  type AdminSection,
} from './admin-sections';
import { RolesAdmin } from './admin/RolesAdmin';
import { DataProtectionPanel } from './DataProtectionPanel';

export interface AdminPanelProps {
  readonly companyId: string;
  readonly companySlug: string;
  /** The open section, from the URL. */
  readonly section: AdminSection;
  /** Opens a section. The caller puts it in the URL. */
  readonly onSelect: (section: AdminSection) => void;
}

/**
 * The Admin tab (002.00): a menu of the company's administration — roles,
 * users, knowledge and data protection — beside the chosen section. The menu
 * behaves as the Data tab's does: arrow keys move, Enter or Space opens, and
 * focus stays on the menu.
 */
export const AdminPanel = ({
  companyId,
  companySlug,
  section,
  onSelect,
}: AdminPanelProps) => (
  <div className="tcp-side-menu">
    <div className="tcp-side-menu__menu">
      <ListBox
        className="react-aria-ListBox tcp-side-menu__list"
        aria-label={t('admin.menu.label')}
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={[section]}
        onSelectionChange={(keys) => {
          if (keys === 'all') return;
          const [key] = [...keys];
          if (typeof key === 'string' && isAdminSection(key)) onSelect(key);
        }}
      >
        {ADMIN_SECTIONS.map(({ id, label }) => (
          <ListBoxItem key={id} id={id} className="react-aria-ListBoxItem">
            {t(label)}
          </ListBoxItem>
        ))}
      </ListBox>
    </div>
    <div>
      {section === 'roles' ? (
        <RolesAdmin companyId={companyId} />
      ) : section === 'data-protection' ? (
        <DataProtectionPanel companyId={companyId} companySlug={companySlug} />
      ) : (
        <p>{t('admin.placeholder')}</p>
      )}
    </div>
  </div>
);
