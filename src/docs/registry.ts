import type { DocPage, Group } from './types';
import { GET_STARTED } from './pages/getStarted';
import { BUILD } from './pages/build';
import { SHIP } from './pages/ship';
import { SUPPORT } from './pages/support';
import { TEAM } from './pages/team';

export const GROUP_ORDER: Group[] = ['Get started', 'Build', 'Ship', 'Support & sales', 'Team & account', 'Reference'];

export const GROUP_LABEL: Record<'en' | 'ko', Record<Group, string>> = {
  en: {
    'Get started': 'Get started',
    Build: 'Build',
    Ship: 'Ship',
    'Support & sales': 'Support & sales',
    'Team & account': 'Team & account',
    Reference: 'Reference',
  },
  ko: {
    'Get started': '시작하기',
    Build: '만들기',
    Ship: '배포하기',
    'Support & sales': '지원과 영업',
    'Team & account': '팀과 계정',
    Reference: '참고',
  },
};

/** Every page, in reading order (drives the sidebar and Previous/Next). */
export const PAGES: DocPage[] = [...GET_STARTED, ...BUILD, ...SHIP, ...SUPPORT, ...TEAM].sort(
  (a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group),
);

/**
 * Pages from the previous docs (before October 2026) and where their content
 * lives now. Old links, bookmarks and search results keep working.
 */
export const REDIRECTS: Record<string, string> = {
  '/docs/getting-started': '/docs/get-started/sign-up',
  '/docs/sign-in': '/docs/get-started/sign-up',
  '/docs/first-project': '/docs/get-started/first-project',
  '/docs/first-todo': '/docs/build/tasks',
  '/docs/run-agent': '/docs/get-started/first-job',
  '/docs/todos/creating': '/docs/build/tasks',
  '/docs/todos/lifecycle': '/docs/build/tasks',
  '/docs/todos/comments': '/docs/build/tasks',
  '/docs/channels/types': '/docs/build/tasks',
  '/docs/channels/organizing': '/docs/build/tasks',
  '/docs/agents/overview': '/docs/build/agents',
  '/docs/agents/claude-vs-codex': '/docs/build/agents',
  '/docs/agents/tools': '/docs/build/agents',
  '/docs/agents/system-prompt': '/docs/build/agents',
  '/docs/agents/reviewing': '/docs/ship/review-and-merge',
  '/docs/projects/settings': '/docs/get-started/find-your-way',
  '/docs/projects/worktrees': '/docs/ship/github',
  '/docs/widget/overview': '/docs/support/widget',
  '/docs/widget/install': '/docs/support/widget',
  '/docs/widget/triager': '/docs/support/inbox',
  '/docs/workflows': '/docs/build/agent-chat',
  '/docs/team/invites': '/docs/team/invite',
};
