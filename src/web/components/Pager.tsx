import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { t } from '../i18n';

/** A table footer: the summary on the left, previous/next page buttons on the right. */
export function Pager({
  as: Element = 'div',
  className,
  summary,
  page,
  pages,
  previousLabel,
  nextLabel,
  disabled,
  onPage,
}: {
  as?: 'div' | 'footer';
  className: string;
  summary: ReactNode;
  page: number;
  pages: number;
  previousLabel: string;
  nextLabel: string;
  disabled: boolean;
  onPage: (page: number) => void;
}) {
  return (
    <Element className={`pager ${className}`}>
      <span>{summary}</span>
      <div>
        <button
          type="button"
          className="toolbar-icon"
          disabled={page <= 1 || disabled}
          aria-label={previousLabel}
          onClick={() => onPage(page - 1)}
        >
          <ChevronLeft size={16} />
        </button>
        <span>{t('insights.pageOf', { page, pages })}</span>
        <button
          type="button"
          className="toolbar-icon"
          disabled={page >= pages || disabled}
          aria-label={nextLabel}
          onClick={() => onPage(page + 1)}
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </Element>
  );
}
