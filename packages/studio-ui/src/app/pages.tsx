import type { NavSection } from '@coderush/ckit-components/app-nav';
import { LayoutDashboard, type LucideIcon } from 'lucide-react';
import { useMemo, type ReactElement } from 'react';
import { Overview } from '../pages/Overview';
import { canOpen, useCapabilities, type Requirement } from './capabilities';

export const PRODUCT_NAME = 'Spina Studio';

export type PageSection = 'Observe' | 'Inspect' | 'Authorize';
export const SECTIONS: readonly PageSection[] = ['Observe', 'Inspect', 'Authorize'];

export interface StudioPage extends Requirement {
  /** Route path; a page with nested routes ends in `/*`. */
  path: string;
  label: string;
  icon: LucideIcon;
  section: PageSection;
  element: ReactElement;
  /** Detail routes stay out of the sidebar and the palette. */
  nav?: false;
}

export const pages: StudioPage[] = [{ path: '/', label: 'Overview', icon: LayoutDashboard, section: 'Observe', element: <Overview /> }];

export const hrefOf = (page: StudioPage): string => page.path.replace(/\/\*$/, '') || '/';

export function useNavSections(): NavSection[] {
  const capabilities = useCapabilities();
  return useMemo(
    () =>
      SECTIONS.map((label) => ({
        label,
        items: pages
          .filter((page) => page.section === label && page.nav !== false && canOpen(capabilities, page))
          .map((page) => {
            const Icon = page.icon;
            const href = hrefOf(page);
            return { label: page.label, href, icon: <Icon aria-hidden />, end: href === '/' };
          }),
      })).filter((section) => section.items.length > 0),
    [capabilities],
  );
}
