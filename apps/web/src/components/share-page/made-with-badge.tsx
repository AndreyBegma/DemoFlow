import { buttonClassName } from '@andrewbehma/glass-ui/button';
import { Logomark } from '@/components/brand/logo';
import { t } from '@/i18n';

/**
 * "Made with DemoFlow": the share page's only way to the landing page, small
 * and below the player, never over the video (spec #351, Decision 2).
 */
export function MadeWithBadge() {
  return (
    <a
      href="/"
      className={buttonClassName({
        variant: 'glass',
        size: 'sm',
        className: 'gap-2',
      })}
    >
      <Logomark size={16} />
      {t('sharePage.madeWith')}
    </a>
  );
}
