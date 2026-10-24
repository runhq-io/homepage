import type { ReactNode } from 'react';

/** Sidebar groups, in display order (see GROUP_ORDER in registry.ts). */
export type Group =
  | 'Get started'
  | 'Build'
  | 'Ship'
  | 'Support & sales'
  | 'Team & account'
  | 'Reference';

export interface Section {
  /** Anchor id: stable, used in deep links (#id) and the "On this page" list. */
  id: string;
  heading: string;
  body: ReactNode;
}

export interface DocPage {
  /** Canonical, unprefixed path (e.g. "/docs/build/jobs"). /ko twins are derived. */
  path: string;
  group: Group;
  title: string;
  /** One-line summary under the title; also searched by the sidebar filter. */
  lede?: ReactNode;
  /** Extra words the sidebar filter should match (synonyms, old names). */
  keywords?: string[];
  hero?: ReactNode;
  sections: Section[];
}
