import { Download } from 'lucide-react';
import { useState } from 'react';
import { Button } from 'react-aria-components';
import {
  downloadAllRecordTables,
  downloadRecordTableCsv,
  useLiveCompanyState,
  useRecordTables,
} from '../../../../api/hooks';
import { Dialog } from '../../../../components/Dialog/Dialog';
import { RecordTableActions } from '../../../../components/RecordSheet/RecordTableActions';
import { TableView } from '../../../../components/RecordSheet/TableView';
import { announceRecords } from '../../../../components/RecordSheet/announceRecords';
import { RoundIconButton } from '../../../../components/RoundIconButton/RoundIconButton';
import { t } from '../../../../strings';
import { TrayPanel } from './TrayPanel';

export interface RecordsDetailsProps {
  readonly companyId: string;
  readonly headingId: string;
  /** Where dialogs, menus and tooltips open, to stay inside full screen. */
  readonly portalContainer?: Element | undefined;
}

/**
 * The filing cabinet's tray (001.03): the company's record tables, each with
 * its record count, a download and a "More actions" menu, and a round
 * "download all" control in the title bar. A table's name opens it in a
 * dialog as an editable sheet.
 *
 * The company is fetched only for its `slug`, which names downloaded files.
 */
export const RecordsDetails = ({
  companyId,
  headingId,
  portalContainer,
}: RecordsDetailsProps) => {
  const tables = useRecordTables(companyId);
  const companyQuery = useLiveCompanyState(companyId);
  const [open, setOpen] = useState<string | null>(null);
  const heading = t('records.tray.heading');

  // A deleted table's row is gone, with its menu: focus the tray's heading,
  // a stable neighbour, rather than leave it on nothing (ADR-027).
  const focusHeading = () => document.getElementById(headingId)?.focus();

  if (tables.isPending || companyQuery.isPending) {
    return (
      <TrayPanel headingId={headingId} heading={heading}>
        <p>{t('visualisation.tray.loading')}</p>
      </TrayPanel>
    );
  }
  const slug = companyQuery.data?.slug;
  if (tables.isError || companyQuery.isError || slug === undefined) {
    return (
      <TrayPanel headingId={headingId} heading={heading}>
        <p>{t('visualisation.tray.gone')}</p>
      </TrayPanel>
    );
  }

  const list = tables.data;
  return (
    <TrayPanel
      headingId={headingId}
      heading={heading}
      actions={
        <RoundIconButton
          icon={Download}
          label={t('records.downloadAll')}
          isDisabled={list.length === 0}
          portalContainer={portalContainer}
          onPress={() =>
            void downloadAllRecordTables(companyId, slug).catch(() =>
              announceRecords('records.downloadFailed'),
            )
          }
        />
      }
    >
      {list.length === 0 ? (
        <p>{t('tables.empty')}</p>
      ) : (
        <table className="records-tray__table" aria-labelledby={headingId}>
          <thead>
            <tr>
              <th scope="col">{t('records.tray.column.table')}</th>
              <th scope="col">{t('records.tray.column.records')}</th>
              <th scope="col">{t('records.tray.column.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {list.map((table) => (
              <tr key={table.name}>
                <th scope="row">
                  <Button
                    className="react-aria-Button records-tray__open"
                    onPress={() => setOpen(table.name)}
                  >
                    {table.name}
                  </Button>
                </th>
                <td>{table.records}</td>
                <td>
                  <div className="records-tray__actions">
                    <RoundIconButton
                      icon={Download}
                      label={t('records.download', { table: table.name })}
                      outline
                      portalContainer={portalContainer}
                      onPress={() =>
                        void downloadRecordTableCsv(
                          companyId,
                          slug,
                          table.name,
                        ).catch(() => announceRecords('records.downloadFailed'))
                      }
                    />
                    <RecordTableActions
                      companyId={companyId}
                      companySlug={slug}
                      table={table.name}
                      records={table.records}
                      onDropped={focusHeading}
                      portalContainer={portalContainer}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open !== null && (
        <Dialog
          heading={open}
          portalContainer={portalContainer}
          onClose={() => setOpen(null)}
        >
          <div className="records-tray__dialog">
            <TableView
              companyId={companyId}
              companySlug={slug}
              table={open}
              portalContainer={portalContainer}
              onDropped={() => {
                setOpen(null);
                focusHeading();
              }}
            />
          </div>
        </Dialog>
      )}
    </TrayPanel>
  );
};
