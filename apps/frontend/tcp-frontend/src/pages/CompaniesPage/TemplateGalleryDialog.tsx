import { useId, useState } from 'react';
import { Button } from 'react-aria-components';
import { ApiError } from '../../api/errors';
import {
  downloadTemplate,
  usePreviewTemplate,
  useTemplateGallery,
} from '../../api/hooks';
import type { CompanyTemplatePreview, GalleryTemplate } from '../../api/dtos';
import { ButtonRow } from '../../components/ButtonRow/ButtonRow';
import { Dialog } from '../../components/Dialog/Dialog';
import { ErrorState } from '../../components/ErrorState/ErrorState';
import { LoadingState } from '../../components/LoadingState/LoadingState';
import { t, tCount } from '../../strings';

/** The announcer channel shared with the companies page. */
const CHANNEL = 'companies';

/** A template the person picked, read but not yet imported. */
export interface ChosenTemplate {
  readonly preview: CompanyTemplatePreview;
  /** The uploaded zip, or a gallery entry as `<sourceId>/<name>`. */
  readonly source: File | string;
}

export interface TemplateGalleryDialogProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  /** The person wants a blank company rather than a template. */
  readonly onScratch: () => void;
  readonly onChosen: (chosen: ChosenTemplate) => void;
}

/**
 * The first step of New company (002.03): start blank, import a zip, or pick
 * a template from the gallery. Mounts its contents only while open, so a
 * closed dialog costs the page no request.
 */
export const TemplateGalleryDialog = ({
  isOpen,
  ...rest
}: TemplateGalleryDialogProps) => (isOpen ? <OpenGallery {...rest} /> : null);

/** The gallery's templates under a heading per source, in the order the API gave them. */
const bySource = (
  templates: readonly GalleryTemplate[],
): [string, GalleryTemplate[]][] => {
  const groups = new Map<string, GalleryTemplate[]>();
  for (const template of templates) {
    groups.set(template.sourceName, [
      ...(groups.get(template.sourceName) ?? []),
      template,
    ]);
  }
  return [...groups];
};

const OpenGallery = ({
  onClose,
  onScratch,
  onChosen,
}: Omit<TemplateGalleryDialogProps, 'isOpen'>) => {
  const gallery = useTemplateGallery();
  const preview = usePreviewTemplate();
  const [problem, setProblem] = useState<string | null>(null);
  const fileId = useId();

  /** Reads the template; a 400 carries the server's list of what is wrong with it. */
  const choose = async (source: File | string): Promise<void> => {
    if (preview.isPending) return;
    setProblem(null);
    try {
      onChosen({ preview: await preview.mutateAsync(source), source });
    } catch (error) {
      setProblem(
        error instanceof ApiError && error.status === 400
          ? error.message
          : t('records.error.generic'),
      );
    }
  };

  const download = (template: GalleryTemplate): void => {
    setProblem(null);
    downloadTemplate(template.sourceId, template.name).catch(() =>
      setProblem(t('companies.gallery.downloadFailed')),
    );
  };

  const body = () => {
    if (gallery.isPending) {
      return <LoadingState label={t('companies.gallery.loading')} />;
    }
    if (gallery.isError) {
      return (
        <ErrorState
          message={t('records.error.generic')}
          channel={CHANNEL}
          onRetry={() => {
            void gallery.refetch();
          }}
        />
      );
    }
    const { templates, warnings } = gallery.data;
    return (
      <>
        {warnings.length > 0 && (
          <>
            <p>{t('companies.gallery.warnings')}</p>
            <ul>
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </>
        )}
        {templates.length === 0 && <p>{t('companies.gallery.empty')}</p>}
        {bySource(templates).map(([sourceName, group]) => (
          <section key={sourceName}>
            <h3>{sourceName}</h3>
            <ul>
              {group.map((template) => (
                <li key={`${template.sourceId}/${template.name}`}>
                  <h4>{template.title}</h4>
                  <p>{template.description}</p>
                  <p>
                    {t('companies.gallery.counts', {
                      roles: tCount('companies.gallery.roles', template.roles),
                      documents: tCount(
                        'companies.gallery.documents',
                        template.documents,
                      ),
                    })}
                  </p>
                  <ButtonRow>
                    <Button
                      className="react-aria-Button"
                      aria-label={t('companies.gallery.useNamed', {
                        title: template.title,
                      })}
                      onPress={() =>
                        void choose(`${template.sourceId}/${template.name}`)
                      }
                    >
                      {t('companies.gallery.use')}
                    </Button>
                    <Button
                      className="react-aria-Button tcp-button--outline"
                      aria-label={t('companies.gallery.downloadNamed', {
                        title: template.title,
                      })}
                      onPress={() => download(template)}
                    >
                      {t('companies.gallery.download')}
                    </Button>
                  </ButtonRow>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </>
    );
  };

  return (
    <Dialog heading={t('companies.gallery.heading')} onClose={onClose}>
      {/*
        Everything stays mounted while a template is read, so the button just
        pressed keeps focus, and is still there if reading it fails.
      */}
      {preview.isPending && (
        <LoadingState label={t('companies.gallery.reading')} />
      )}
      <ButtonRow>
        <Button className="react-aria-Button" onPress={onScratch}>
          {t('companies.gallery.scratch')}
        </Button>
        {/*
            A native file input, as `KnowledgePanel` and `CreateTaskDialog`
            use: labelled and keyboard-operable with no code of ours, which a
            button hiding an input would have to rebuild.
          */}
        <label htmlFor={fileId}>
          {t('companies.gallery.importFile')}
          {/* eslint-disable-next-line jsx-a11y/control-has-associated-label -- the label is `t()`, which jsx-a11y can't read; see KnowledgePanel */}
          <input
            id={fileId}
            type="file"
            accept=".zip,application/zip"
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Cleared so choosing the same file again still fires a change.
              event.target.value = '';
              if (file !== undefined) void choose(file);
            }}
          />
        </label>
      </ButtonRow>
      {problem !== null && <p className="tcp-field__error">{problem}</p>}
      {body()}
    </Dialog>
  );
};
