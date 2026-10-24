'use client';

import { Checkbox } from '@andrewbehma/glass-ui/checkbox';
import { Radio, RadioGroup } from '@andrewbehma/glass-ui/radio-group';
import { t } from '@/i18n';
import {
  FORMAT_ORDER,
  orderFormats,
  type PlayableFormat,
} from '@/lib/playback';

/** Rows are landscape, vertical, square; columns MP4, WebM, GIF. */
const GRID: readonly PlayableFormat[] = [
  'mp4',
  'webm',
  'gif',
  'mp4-vertical',
  'webm-vertical',
  'gif-vertical',
  'mp4-square',
  'webm-square',
  'gif-square',
];

/** The label of one format; an unknown string is shown as it is. */
export function formatLabel(format: string): string {
  const known = FORMAT_ORDER.find((candidate) => candidate === format);
  return known ? t(`runPage.formats.${known}`) : format;
}

/** "GIF, Vertical MP4": the formats in display order, as one list. */
export function formatList(formats: readonly string[]): string {
  return orderFormats(formats).map(formatLabel).join(', ');
}

/**
 * The format choice of the "Run a scenario" card (spec #327): the project's
 * own formats (nothing is sent), or a set of checkboxes. Controlled by the
 * card, so the ticks survive switching modes.
 */
export function FormatChoice({
  choosing,
  ticked,
  disabled,
  onChoosingChange,
  onTickedChange,
}: {
  choosing: boolean;
  ticked: readonly PlayableFormat[];
  disabled: boolean;
  onChoosingChange: (choosing: boolean) => void;
  onTickedChange: (ticked: PlayableFormat[]) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <RadioGroup label={t('projects.launch.formats.label')}>
        <Radio
          name="launch-formats"
          label={t('projects.launch.formats.project')}
          checked={!choosing}
          disabled={disabled}
          onChange={() => onChoosingChange(false)}
        />
        <Radio
          name="launch-formats"
          label={t('projects.launch.formats.choose')}
          checked={choosing}
          disabled={disabled}
          onChange={() => onChoosingChange(true)}
        />
      </RadioGroup>
      {choosing ? (
        <>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-x-4 gap-y-2">
            {GRID.map((format) => (
              <Checkbox
                key={format}
                label={formatLabel(format)}
                checked={ticked.includes(format)}
                disabled={disabled}
                onChange={(event) =>
                  onTickedChange(
                    orderFormats(
                      event.target.checked
                        ? [...ticked, format]
                        : ticked.filter((candidate) => candidate !== format),
                    ),
                  )
                }
              />
            ))}
          </div>
          {ticked.length === 0 ? (
            <p className="text-sm text-ink-2">
              {t('projects.launch.formats.pickOne')}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
