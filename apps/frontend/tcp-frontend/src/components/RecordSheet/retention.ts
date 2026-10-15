import type { RecordTableDefinition } from '../../api/dtos';
import { t } from '../../strings';

/**
 * A table's retention in words, for under its title: "Rows are deleted 180
 * days after delivered_on." Null when rows are kept until deleted.
 */
export const retentionSummary = (
  definition: RecordTableDefinition,
): string | null => {
  const { retention } = definition;
  if (retention === null) return null;
  return retention.from === 'updated'
    ? t('records.retention.summaryUpdated', { days: retention.days })
    : t('records.retention.summaryField', {
        days: retention.days,
        field: retention.from,
      });
};
