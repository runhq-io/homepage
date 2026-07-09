import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Navbar, Footer, SIGNUP_URL } from '../components/chrome';
import { useT, useLocale } from '../i18n/context';

// =============================================================================
// Inline helpers — keep markup short inside the page registry below.
// =============================================================================

const P = ({ children }: { children: React.ReactNode }) => <p className="rhpd-p">{children}</p>;
const Em = ({ children }: { children: React.ReactNode }) => <span className="rhpd-em">{children}</span>;
const Kbd = ({ children }: { children: React.ReactNode }) => <span className="rhpd-kbd">{children}</span>;
const UL = ({ children }: { children: React.ReactNode }) => <ul className="rhpd-ul">{children}</ul>;
const OL = ({ children }: { children: React.ReactNode }) => <ol className="rhpd-ol">{children}</ol>;

// NL: internal docs link. Paths are absolute and locale-free (e.g. "/docs/foo").
const NL = ({ to, children }: { to: string; children: React.ReactNode }) => {
  return <Link className="rhpd-link" to={to}>{children}</Link>;
};

// LL: locale-aware Link with a caller-supplied className. Used for buttons and
// card links in WELCOME_HERO where we need custom classes.
const LL = ({ to, className, children }: { to: string; className?: string; children: React.ReactNode }) => {
  return <Link className={className} to={to}>{children}</Link>;
};

const Code = ({ title, children }: { title?: string; children: string }) => (
  <div className="rhpd-code-card">
    {title && <div className="rhpd-code-h">{title}</div>}
    <pre className="rhpd-code">{children}</pre>
  </div>
);

const Callout = ({ kind = 'tip', children }: { kind?: 'tip' | 'warn'; children: React.ReactNode }) => (
  <div className={`rhpd-note rhpd-note-${kind}`}>
    <CalloutMark kind={kind} />
    <div>{children}</div>
  </div>
);

const CalloutMark = ({ kind }: { kind: 'tip' | 'warn' }) => {
  const t = useT(DOCS_T);
  return <span className="rhpd-note-mark mono">{kind === 'tip' ? t.calloutTip : t.calloutWarn}</span>;
};

const Steps = ({ children }: { children: React.ReactNode }) => <ol className="rhpd-steps">{children}</ol>;

const Pill = ({ children, kind }: { children: React.ReactNode; kind: 'pending' | 'progress' | 'review' | 'done' | 'deployed' | 'cancelled' }) => (
  <span className={`rhpd-pill rhpd-pill-${kind}`}>{children}</span>
);

// =============================================================================
// Page registry
// =============================================================================

type Section = { id: string; heading: string; body: React.ReactNode };
// Group is keyed off the English labels so the registry type stays stable;
// the displayed label is looked up via GROUP_LABEL at render time.
type Group = 'Get started' | 'Todos' | 'Channels' | 'Agents' | 'Projects' | 'The widget' | 'Workflows' | 'Team & access';

interface DocPage {
  path: string;
  group: Group;
  title: string;
  lede?: React.ReactNode;
  hero?: React.ReactNode;
  sections: Section[];
  outro?: React.ReactNode;
}

const GROUP_ORDER: Group[] = [
  'Get started',
  'Todos',
  'Channels',
  'Agents',
  'Projects',
  'The widget',
  'Workflows',
  'Team & access',
];

const GROUP_LABEL: Record<'en' | 'ko', Record<Group, string>> = {
  en: {
    'Get started': 'Get started',
    'Todos': 'Todos',
    'Channels': 'Channels',
    'Agents': 'Agents',
    'Projects': 'Projects',
    'The widget': 'The widget',
    'Workflows': 'Workflows',
    'Team & access': 'Team & access',
  },
  ko: {
    'Get started': '시작하기',
    'Todos': '할 일',
    'Channels': '채널',
    'Agents': 'agent',
    'Projects': '프로젝트',
    'The widget': '위젯',
    'Workflows': '워크플로',
    'Team & access': '팀 및 접근 권한',
  },
};

// =============================================================================
// UI chrome strings
// =============================================================================

const DOCS_T = {
  en: {
    crumbsDocs: 'Docs',
    crumbsNotFound: 'Not found',
    onThisPage: 'On this page',
    tocMeta: 'v2.2 · last updated May 10',
    searchPlaceholder: 'Filter docs…',
    searchClear: 'Clear',
    prevLabel: 'Previous',
    nextLabel: 'Next',
    helpH: 'Need a hand?',
    helpP: 'Solutions team responds in <4 hours, weekdays. Enterprise is 24/7.',
    helpOpenChat: 'Open chat',
    helpEmail: 'Email support →',
    notFoundH1: "That page doesn't exist.",
    notFoundLedePre: 'Try the ',
    notFoundLedeLink: 'welcome page',
    notFoundLedeSuffix: ' or use the search above.',
    welcomeGetStarted: 'Get started →',
    welcomeHowAgents: 'How agents work',
    welcomeWhereToStart: 'Where to start',
    welcomeWhatsNew: "What's new",
    welcomeReadLink: 'Read →',
    clKindFeature: 'New',
    clKindRelease: 'Update',
    calloutTip: 'Tip',
    calloutWarn: 'Heads up',
  },
  ko: {
    crumbsDocs: '문서',
    crumbsNotFound: '찾을 수 없음',
    onThisPage: '이 페이지',
    tocMeta: 'v2.2 · 최종 업데이트 5월 10일',
    searchPlaceholder: '문서 검색…',
    searchClear: '지우기',
    prevLabel: '이전',
    nextLabel: '다음',
    helpH: '도움이 필요하신가요?',
    helpP: '솔루션 팀은 평일 4시간 이내에 응답합니다. 엔터프라이즈는 24시간 지원됩니다.',
    helpOpenChat: '채팅 열기',
    helpEmail: '이메일 문의 →',
    notFoundH1: '해당 페이지를 찾을 수 없습니다.',
    notFoundLedePre: '',
    notFoundLedeLink: '시작 페이지',
    notFoundLedeSuffix: '로 이동하거나 위 검색을 이용하세요.',
    welcomeGetStarted: '시작하기 →',
    welcomeHowAgents: '에이전트가 작동하는 방식',
    welcomeWhereToStart: '어디서부터 시작할까요',
    welcomeWhatsNew: '새 소식',
    welcomeReadLink: '읽기 →',
    clKindFeature: '신규',
    clKindRelease: '업데이트',
    calloutTip: '팁',
    calloutWarn: '주의',
  },
} as const;

// =============================================================================
// Welcome page hero & changelog (locale-specific)
// =============================================================================

type DocCard = { t: string; d: string; tag: string; icon: string; to: string };

const DOC_CARDS_EN: DocCard[] = [
  { t: 'Set up your first project',  d: "Pick a name, an icon, and you're running. RunHQ creates the channels you'll need.", tag: 'Get started', icon: '◯', to: '/docs/first-project' },
  { t: 'File a todo',                d: 'Todos are the unit of work. Anyone on the team can file one.',                       tag: 'Get started', icon: '◢', to: '/docs/first-todo' },
  { t: 'Run an agent',               d: 'Hit Run on a todo. Watch Claude or Codex pick it up live.',                          tag: 'Get started', icon: '⚡', to: '/docs/run-agent' },
  { t: 'Review the diff',            d: 'When the agent finishes, you decide what ships.',                                    tag: 'Daily',       icon: '◇', to: '/docs/agents/reviewing' },
  { t: 'Capture feedback on your site', d: 'Drop the widget on any page. Users file todos straight into your queue.',         tag: 'Setup',       icon: '◉', to: '/docs/widget/overview' },
  { t: 'Invite your team',           d: 'Add teammates. Pick what each role can see and do.',                                 tag: 'For admins',  icon: '◈', to: '/docs/team/invites' },
];

const DOC_CARDS_KO: DocCard[] = [
  { t: '첫 프로젝트 설정',           d: '이름과 아이콘만 정하면 바로 시작됩니다. RunHQ가 필요한 채널을 자동으로 만들어 둡니다.', tag: '시작하기',   icon: '◯', to: '/docs/first-project' },
  { t: '할 일 만들기',               d: '할 일은 작업의 기본 단위입니다. 팀의 누구나 만들 수 있습니다.',                          tag: '시작하기',   icon: '◢', to: '/docs/first-todo' },
  { t: '에이전트 실행',              d: '할 일에서 Run을 누르세요. Claude나 Codex가 즉시 이어받아 작업합니다.',                   tag: '시작하기',   icon: '⚡', to: '/docs/run-에이전트' },
  { t: '변경 사항 리뷰',             d: '에이전트가 작업을 마치면, 무엇을 배포할지는 사람이 결정합니다.',                          tag: '일상 작업',  icon: '◇', to: '/docs/에이전트/reviewing' },
  { t: '사이트에서 피드백 받기',     d: '아무 페이지에나 위젯을 붙이세요. 사용자가 곧장 큐에 할 일을 남깁니다.',                    tag: '설치',      icon: '◉', to: '/docs/widget/overview' },
  { t: '팀원 초대',                  d: '팀원을 추가하고, 각 역할이 보고 수행할 수 있는 권한을 설정하세요.',                       tag: '관리자용',  icon: '◈', to: '/docs/team/invites' },
];

type ChangelogItem = { date: string; title: string; kind: 'feature' | 'release' };

const WHATS_NEW_EN: ChangelogItem[] = [
  { date: '2026-05-08', title: 'Multiple agents can now work at once without their changes colliding.', kind: 'feature' },
  { date: '2026-04-30', title: 'Codex (OpenAI) is now an official agent option, alongside Claude Code.', kind: 'release' },
  { date: '2026-04-22', title: 'Smarter triaging — todos route to the agent most active in the relevant channel.', kind: 'feature' },
  { date: '2026-04-12', title: 'Sessions are now called Jobs. Same thing, clearer name.', kind: 'release' },
];

const WHATS_NEW_KO: ChangelogItem[] = [
  { date: '2026-05-08', title: '이제 여러 에이전트가 동시에 작업해도 변경 사항이 충돌하지 않습니다.', kind: 'feature' },
  { date: '2026-04-30', title: 'Claude Code와 함께 Codex(OpenAI)도 정식 에이전트 옵션으로 추가됐습니다.', kind: 'release' },
  { date: '2026-04-22', title: '더 똑똑해진 트리아지 — 할 일이 해당 채널에서 가장 활발한 에이전트로 자동 배정됩니다.', kind: 'feature' },
  { date: '2026-04-12', title: '세션의 새 이름은 잡(Job)입니다. 같은 기능, 더 명확한 이름.', kind: 'release' },
];

const WELCOME_HERO_EN = (
  <>
    <div className="rhpd-actions">
      <LL className="rhp-btn-primary" to="/docs/sign-in">Get started →</LL>
      <LL className="rhp-btn-ghost" to="/docs/agents/overview">How agents work</LL>
    </div>

    <h2 className="rhpd-h2" id="pick-a-path">Where to start</h2>
    <div className="rhpd-cards">
      {DOC_CARDS_EN.map((c) => (
        <LL key={c.t} className="rhpd-card" to={c.to}>
          <div className="rhpd-card-icon">{c.icon}</div>
          <div className="rhpd-card-tag mono">{c.tag}</div>
          <div className="rhpd-card-t">{c.t}</div>
          <div className="rhpd-card-d">{c.d}</div>
          <div className="rhpd-card-link">Read →</div>
        </LL>
      ))}
    </div>
  </>
);

const WELCOME_HERO_KO = (
  <>
    <div className="rhpd-actions">
      <LL className="rhp-btn-primary" to="/docs/sign-in">시작하기 →</LL>
      <LL className="rhp-btn-ghost" to="/docs/에이전트/overview">에이전트가 작동하는 방식</LL>
    </div>

    <h2 className="rhpd-h2" id="pick-a-path">어디서부터 시작할까요</h2>
    <div className="rhpd-cards">
      {DOC_CARDS_KO.map((c) => (
        <LL key={c.t} className="rhpd-card" to={c.to}>
          <div className="rhpd-card-icon">{c.icon}</div>
          <div className="rhpd-card-tag mono">{c.tag}</div>
          <div className="rhpd-card-t">{c.t}</div>
          <div className="rhpd-card-d">{c.d}</div>
          <div className="rhpd-card-link">읽기 →</div>
        </LL>
      ))}
    </div>
  </>
);

const WELCOME_OUTRO_EN = (
  <>
    <h2 className="rhpd-h2" id="whats-new">What's new</h2>
    <ul className="rhpd-changelog">
      {WHATS_NEW_EN.map((c) => (
        <li key={c.title}>
          <span className="rhpd-cl-date mono">{c.date}</span>
          <span className="rhpd-cl-t">{c.title}</span>
          <span className={`rhpd-cl-kind rhpd-cl-${c.kind}`}>{c.kind === 'feature' ? 'New' : 'Update'}</span>
        </li>
      ))}
    </ul>
  </>
);

const WELCOME_OUTRO_KO = (
  <>
    <h2 className="rhpd-h2" id="whats-new">새 소식</h2>
    <ul className="rhpd-changelog">
      {WHATS_NEW_KO.map((c) => (
        <li key={c.title}>
          <span className="rhpd-cl-date mono">{c.date}</span>
          <span className="rhpd-cl-t">{c.title}</span>
          <span className={`rhpd-cl-kind rhpd-cl-${c.kind}`}>{c.kind === 'feature' ? '신규' : '업데이트'}</span>
        </li>
      ))}
    </ul>
  </>
);

// =============================================================================
// PAGES — English
// =============================================================================

const PAGES_EN: DocPage[] = [
  // ============================================================ Get started
  {
    path: '/docs',
    group: 'Get started',
    title: 'Welcome to RunHQ',
    lede: (
      <>RunHQ is where your team's AI coding agents do their work. File a todo from anywhere — a meeting, a Slack thread, an email, the widget on your site — and an agent picks it up, writes the change, and hands the diff back for review. One workspace. One inbox. Everything on the record.</>
    ),
    hero: WELCOME_HERO_EN,
    sections: [],
    outro: WELCOME_OUTRO_EN,
  },

  {
    path: '/docs/sign-in',
    group: 'Get started',
    title: 'Sign in for the first time',
    lede: <>You only need to do this once. After that, RunHQ remembers you on every device you sign in from.</>,
    sections: [
      {
        id: 'open',
        heading: 'Open the app',
        body: (
          <>
            <P>Go to <Em>app.runhq.io</Em> in any modern browser. Sign in with Google or with the email your team uses at work.</P>
            <P>If your company already has a RunHQ workspace, you'll join it automatically as long as your email matches the company domain. If not, you'll be prompted to create a new workspace.</P>
          </>
        ),
      },
      {
        id: 'lay',
        heading: 'The lay of the land',
        body: (
          <>
            <P>Your sidebar has three things:</P>
            <UL>
              <li><Em>Projects</Em> at the top — each one is a place where work happens. New workspaces start with a project called <Em>General</Em>.</li>
              <li><Em>Inbox</Em> — todos that don't belong to a project yet, plus mentions and replies.</li>
              <li><Em>Settings</Em> at the bottom — your profile, team, billing.</li>
            </UL>
            <P>Open the <Em>General</Em> project. You'll see three channels along the top: <Em>Todos</Em>, <Em>Browser</Em>, and <Em>Chat</Em>. That's the standard layout for any project.</P>
          </>
        ),
      },
      {
        id: 'next',
        heading: 'Next steps',
        body: (
          <UL>
            <li>Create a project for the work you actually want to do — see <NL to="/docs/first-project">Your first project</NL>.</li>
            <li>Or skip ahead: file a todo in the General project to try it out — see <NL to="/docs/first-todo">File your first todo</NL>.</li>
            <li>If you're an admin, <NL to="/docs/team/invites">invite your team</NL> before you do too much else.</li>
          </UL>
        ),
      },
    ],
  },

  {
    path: '/docs/first-project',
    group: 'Get started',
    title: 'Your first project',
    lede: <>Every piece of work in RunHQ lives in a project. Most teams keep one project per repo or one per product surface — pick whatever matches how your team already thinks about the work.</>,
    sections: [
      {
        id: 'create',
        heading: 'Create a project',
        body: (
          <>
            <Steps>
              <li>In the sidebar, click the <Em>+</Em> button next to <Em>Projects</Em>.</li>
              <li>Give the project a name — usually your repo or product surface.</li>
              <li>Pick an icon and color. These show up in the sidebar so projects are easy to scan at a glance.</li>
              <li>Optional: set a folder name. This is the working directory on disk where agents check out code.</li>
              <li>Click <Em>Create</Em>.</li>
            </Steps>
          </>
        ),
      },
      {
        id: 'defaults',
        heading: 'What gets set up automatically',
        body: (
          <>
            <P>Every new project starts with three channels:</P>
            <UL>
              <li><Em>Todos</Em> — your queue of work items. Most things land here.</li>
              <li><Em>Browser</Em> — for tasks that need an agent to navigate the web.</li>
              <li><Em>Chat</Em> — freeform conversation with agents in this project.</li>
            </UL>
            <P>You can rename these later, add more, or archive ones you don't use. See <NL to="/docs/channels/types">Channel types</NL>.</P>
          </>
        ),
      },
      {
        id: 'name',
        heading: 'Naming projects well',
        body: (
          <>
            <P>The two patterns most teams settle on:</P>
            <UL>
              <li><Em>One project per repo.</Em> Easy mental model — a project is "where work for repo X happens."</li>
              <li><Em>One project per product surface.</Em> Better when one repo serves many surfaces, or many repos serve one product.</li>
            </UL>
            <Callout>You can move work between projects later by reassigning the channel. Don't agonize over this on day one.</Callout>
          </>
        ),
      },
    ],
  },

  {
    path: '/docs/first-todo',
    group: 'Get started',
    title: 'File your first todo',
    lede: <>Todos are the unit of work in RunHQ. Anyone on your team can file one. An agent will pick it up later — or you can run one yourself.</>,
    sections: [
      {
        id: 'add',
        heading: 'Add a todo',
        body: (
          <>
            <Steps>
              <li>Open the <Em>Todos</Em> channel in your project.</li>
              <li>Click <Em>+ New todo</Em> at the top, or hit <Kbd>N</Kbd> on your keyboard.</li>
              <li>Give it a short title that says what should change.</li>
              <li>Add description, screenshots, or links if it helps. Drag and drop attachments straight in.</li>
              <li>Hit <Em>File</Em>.</li>
            </Steps>
            <P>Your todo lands in the channel with status <Pill kind="pending">Pending</Pill>. It'll move forward as an agent picks it up.</P>
          </>
        ),
      },
      {
        id: 'good',
        heading: 'What a good todo looks like',
        body: (
          <UL>
            <li><Em>Title</Em> — verb-led, specific. "Fix the password reset link on /login." Not: "login bug."</li>
            <li><Em>Description</Em> — repro steps if it's a bug, the goal if it's a feature, links to anything relevant.</li>
            <li><Em>Attachments</Em> — screenshots almost always make the agent do better work. So do error messages.</li>
          </UL>
        ),
      },
      {
        id: 'sources',
        heading: 'Where todos can come from',
        body: (
          <UL>
            <li><Em>Your team</Em> — anyone with access can file directly in the UI.</li>
            <li><Em>Your users</Em> — drop the <NL to="/docs/widget/overview">widget</NL> on your site and they file directly.</li>
            <li><Em>External tools</Em> — webhooks turn external events into todos automatically. See <NL to="/docs/workflows">Workflows</NL>.</li>
          </UL>
        ),
      },
    ],
  },

  {
    path: '/docs/run-agent',
    group: 'Get started',
    title: 'Run your first agent',
    lede: <>Once you have a todo, running an agent on it takes one click. Here's what you'll see.</>,
    sections: [
      {
        id: 'run',
        heading: 'Hit Run',
        body: (
          <>
            <Steps>
              <li>Open the todo you just filed.</li>
              <li>Click <Em>Run</Em> in the top right.</li>
              <li>Pick an agent (or accept the suggested one — RunHQ picks the agent most active in this channel by default).</li>
              <li>Click <Em>Start</Em>.</li>
            </Steps>
            <P>The todo flips from <Pill kind="pending">Pending</Pill> to <Pill kind="progress">In progress</Pill>. A new entry appears in the <Em>Jobs</Em> panel for this project.</P>
          </>
        ),
      },
      {
        id: 'watching',
        heading: "What you'll see",
        body: (
          <>
            <P>Open the running job. You'll see three panes:</P>
            <UL>
              <li><Em>Terminal</Em> — the agent's live shell session, streaming output as it works.</li>
              <li><Em>Chat</Em> — the conversation between you and the agent. You can ping in mid-run with extra context.</li>
              <li><Em>Files</Em> — the diff so far, building up as the agent edits.</li>
            </UL>
            <P>You don't need to babysit. The job runs in its own copy of your code, so it can't break anything you have open.</P>
          </>
        ),
      },
      {
        id: 'finish',
        heading: 'When the agent finishes',
        body: (
          <>
            <P>The todo flips to <Pill kind="review">Needs review</Pill>. You'll get a notification.</P>
            <P>Open the <Em>Diff</Em> tab on the job and decide:</P>
            <UL>
              <li><Em>Approve</Em> — accept the change. RunHQ pushes the branch.</li>
              <li><Em>Request changes</Em> — drop a comment, the agent tries again.</li>
              <li><Em>Discard</Em> — toss the work, file a fresh todo.</li>
            </UL>
            <P>See <NL to="/docs/agents/reviewing">Reviewing the diff</NL> for the full review flow.</P>
          </>
        ),
      },
    ],
  },

  // ============================================================ Todos
  {
    path: '/docs/todos/creating',
    group: 'Todos',
    title: 'Creating todos',
    lede: <>Todos can come from anywhere — the app, the widget, or an external system. They all land in a todo channel and look the same once they arrive.</>,
    sections: [
      {
        id: 'in-app',
        heading: 'From the app',
        body: (
          <>
            <P>The fastest path. In any todo channel, click <Em>+ New todo</Em> or press <Kbd>N</Kbd>. Title and description, optional attachments, file.</P>
            <P>The user filing the todo is recorded as the reporter — visible on the todo and in the audit log.</P>
          </>
        ),
      },
      {
        id: 'widget',
        heading: 'From the widget on your site',
        body: (
          <>
            <P>The <NL to="/docs/widget/overview">widget</NL> turns user feedback into todos automatically. They land in a channel you choose, with the user's identity attached.</P>
            <P>Most teams keep a separate channel just for widget-captured feedback so they can triage it apart from internal work.</P>
          </>
        ),
      },
      {
        id: 'webhook',
        heading: 'From external events',
        body: (
          <P>Failed deploys, paged alerts, customer email — anything you can hit with a webhook can become a todo. See <NL to="/docs/workflows">Workflows</NL>.</P>
        ),
      },
      {
        id: 'attach',
        heading: 'Attachments',
        body: (
          <>
            <P>Drag images, PDFs, logs, and zip files straight into the description. The agent sees attachments alongside the text — screenshots in particular help a lot.</P>
            <Callout>Don't paste secrets into todo descriptions or attachments. Anything in a todo is visible to anyone with access to the project.</Callout>
          </>
        ),
      },
    ],
  },

  {
    path: '/docs/todos/lifecycle',
    group: 'Todos',
    title: 'The todo lifecycle',
    lede: <>Todos move through a small set of statuses as agents work on them. Most transitions happen automatically — you only mark a few by hand.</>,
    sections: [
      {
        id: 'states',
        heading: 'The statuses',
        body: (
          <>
            <UL>
              <li><Pill kind="pending">Pending</Pill> — nobody's started yet. Default for new todos.</li>
              <li><Pill kind="progress">In progress</Pill> — an agent is actively working on it.</li>
              <li><Pill kind="review">Needs review</Pill> — the agent finished and is waiting on a human.</li>
              <li><Pill kind="done">Done</Pill> — reviewed, approved, branch merged.</li>
              <li><Pill kind="deployed">Deployed</Pill> — shipped to production.</li>
              <li><Pill kind="cancelled">Cancelled</Pill> — closed without shipping.</li>
            </UL>
          </>
        ),
      },
      {
        id: 'auto',
        heading: "What's automatic",
        body: (
          <>
            <P>RunHQ flips status for you in three places:</P>
            <UL>
              <li>When an agent starts a job, the todo moves to <Pill kind="progress">In progress</Pill>.</li>
              <li>When the agent stops with a diff, it moves to <Pill kind="review">Needs review</Pill>.</li>
              <li>When you approve the diff, it moves to <Pill kind="done">Done</Pill>.</li>
            </UL>
          </>
        ),
      },
      {
        id: 'manual',
        heading: 'What you mark by hand',
        body: (
          <UL>
            <li><Pill kind="deployed">Deployed</Pill> — once the change is in production. Some teams wire this to their CI; most click it manually.</li>
            <li><Pill kind="cancelled">Cancelled</Pill> — when a todo is no longer relevant. Cancelling is preferred over deleting; it preserves the audit trail.</li>
          </UL>
        ),
      },
    ],
  },

  {
    path: '/docs/todos/comments',
    group: 'Todos',
    title: 'Comments and upvotes',
    lede: <>Todos are conversations. Add context as you learn it, vote on what matters most, and keep the agent honest with mid-run nudges.</>,
    sections: [
      {
        id: 'comments',
        heading: 'Comments',
        body: (
          <>
            <P>Open any todo and you'll see a comment thread below the description. Drop notes, questions, or reproduction details. Mention teammates with <Kbd>@</Kbd> to ping them.</P>
            <P>While an agent is running, comments you add show up in the agent's chat too. That's how you give it new information mid-run without having to cancel and refile.</P>
          </>
        ),
      },
      {
        id: 'upvotes',
        heading: 'Upvotes',
        body: (
          <>
            <P>Each todo has an upvote button. The number isn't just for show:</P>
            <UL>
              <li>It's a fast way to surface what matters to the team — sort the channel by upvotes when you're triaging.</li>
              <li>The triager reads upvote counts when picking what to run next, if you've enabled auto-run.</li>
              <li>It nudges the conversation. People upvote things they care about; you can see what your team and your users want.</li>
            </UL>
          </>
        ),
      },
      {
        id: 'mentions',
        heading: 'Mentions and notifications',
        body: (
          <P>Mentioning someone with <Kbd>@</Kbd> sends them a notification (in-app and email if they've enabled it). Mentioning an agent — <Kbd>@</Kbd>agent-name — assigns the todo to that agent immediately, skipping the triager.</P>
        ),
      },
    ],
  },

  // ============================================================ Channels
  {
    path: '/docs/channels/types',
    group: 'Channels',
    title: 'Channel types',
    lede: <>Channels organize work inside a project. Each one has a type that decides what it's for and what it can do.</>,
    sections: [
      {
        id: 'todo',
        heading: 'Todo',
        body: <P>A queue of work items. The default channel type, and the one most projects spend most of their time in. Anyone can file todos; agents pick them up and run them.</P>,
      },
      {
        id: 'chat',
        heading: 'Chat',
        body: <P>Freeform conversation with one or more agents. Use it for brainstorming, asking questions, or anything that isn't a discrete piece of work yet. Conversations here can be promoted to todos with a click.</P>,
      },
      {
        id: 'browser',
        heading: 'Browser',
        body: <P>For tasks that need an agent to navigate the web — research, scraping, end-to-end testing. The agent gets a managed browser session you can watch live.</P>,
      },
      {
        id: 'files',
        heading: 'Files',
        body: <P>A direct view into a folder of your project. Agents read and write files here without going through a todo. Useful for ongoing edits that don't fit the todo model — wiki-style notes, configuration, data files.</P>,
      },
      {
        id: 'workflow',
        heading: 'Workflow',
        body: <P>Bound to a workflow. Messages in the channel become workflow runs — useful when you want a conversational interface to a scripted process. Advanced. See <NL to="/docs/workflows">Workflows</NL>.</P>,
      },
    ],
  },

  {
    path: '/docs/channels/organizing',
    group: 'Channels',
    title: 'Organizing your project',
    lede: <>Most teams use one Todos channel and one Chat channel and stop there. Here's when adding more makes sense.</>,
    sections: [
      {
        id: 'split-todos',
        heading: 'Splitting your todo channel',
        body: (
          <>
            <P>Add a second todo channel when:</P>
            <UL>
              <li>You want to keep <Em>bugs</Em> separate from <Em>features</Em>, with different agents on each.</li>
              <li>External feedback (from the widget) should be triaged separately before joining the main queue.</li>
              <li>One sub-team owns a particular surface and shouldn't see noise from elsewhere.</li>
            </UL>
            <P>If you find yourself wanting to filter inside one big channel, that's usually a signal to split.</P>
          </>
        ),
      },
      {
        id: 'browser-channel',
        heading: 'When to add a browser channel',
        body: <P>Whenever you start using an agent for work that involves looking at a web page — competitive research, end-to-end test triage, content audits. The browser channel keeps the screenshots and traces alongside the conversation.</P>,
      },
      {
        id: 'reorder',
        heading: 'Reordering and renaming',
        body: (
          <>
            <P>Channels appear in the order you set. Drag to reorder them in the project's channel list (the row at the top of the project view).</P>
            <P>Rename a channel from its settings menu. Renaming doesn't break links — old URLs keep working.</P>
          </>
        ),
      },
      {
        id: 'archive',
        heading: 'Archiving',
        body: <P>Channels you no longer use should be archived, not deleted. Archived channels stay in the audit log and can be restored. Deleting is permanent and removes the history.</P>,
      },
    ],
  },

  // ============================================================ Agents
  {
    path: '/docs/agents/overview',
    group: 'Agents',
    title: 'What an agent is',
    lede: <>An agent is a teammate that happens to be AI. It has a name, a model behind it, a personality (the system prompt), and a set of capabilities (tools).</>,
    sections: [
      {
        id: 'pieces',
        heading: 'The pieces',
        body: (
          <UL>
            <li><Em>Name and avatar</Em> — how teammates address it. <Kbd>@</Kbd>name to assign work, ping it in chat, see it in the activity log.</li>
            <li><Em>Model</Em> — what's actually running underneath. Claude Sonnet, Claude Haiku, OpenAI's GPT, etc.</li>
            <li><Em>System prompt</Em> — the instructions that shape its behavior. Your team's voice, your team's rules.</li>
            <li><Em>Tools</Em> — what it can do. Run terminal commands? Edit files? Use a browser? Each is on/off.</li>
          </UL>
        ),
      },
      {
        id: 'how-many',
        heading: 'How many agents to make',
        body: (
          <>
            <P>Most teams keep <Em>one or two</Em>. The triager works best when there are clear differences between agents, not a dozen near-duplicates.</P>
            <P>Common pairs:</P>
            <UL>
              <li>One agent for code work (Claude Code), one for research (general-purpose with browser tools).</li>
              <li>One agent per surface: backend agent, frontend agent.</li>
              <li>One careful, deliberative agent (Sonnet) and one faster one for quick chores (Haiku).</li>
            </UL>
          </>
        ),
      },
      {
        id: 'persistence',
        heading: 'Why agents are persistent',
        body: <P>Agents don't have memory of past conversations between jobs — each job is a fresh start. But the <Em>identity</Em> persists: assignment history, audit trail, performance over time. That continuity is what lets you say "the bug is best handled by the backend agent" with confidence.</P>,
      },
    ],
  },

  {
    path: '/docs/agents/claude-vs-codex',
    group: 'Agents',
    title: 'Claude Code or Codex',
    lede: <>Two ways to run a coding agent. Most teams pick Claude Code. Codex is a great fit if you've already standardized on OpenAI.</>,
    sections: [
      {
        id: 'claude',
        heading: 'Claude Code',
        body: (
          <>
            <P>The default and the most common choice. Claude tends to:</P>
            <UL>
              <li>Make smaller, more focused diffs.</li>
              <li>Explain its reasoning step by step in the chat.</li>
              <li>Handle large codebases well — long context, fewer "lost in the middle" misses.</li>
            </UL>
            <P>Pick Claude Code if you want one default that's good at most things.</P>
          </>
        ),
      },
      {
        id: 'codex',
        heading: 'Codex',
        body: (
          <>
            <P>OpenAI's coding CLI, behind their frontier models. Codex tends to:</P>
            <UL>
              <li>Be faster on small, well-scoped tasks.</li>
              <li>Lean toward terse output.</li>
              <li>Fit teams that already pay for OpenAI elsewhere.</li>
            </UL>
            <P>Pick Codex if you've standardized on OpenAI or want to A/B against Claude.</P>
          </>
        ),
      },
      {
        id: 'switching',
        heading: 'Switching later',
        body: <P>You can change the model on an agent at any time. The next job picks up the new model immediately. Past job history stays linked to the agent — switching doesn't reset anything.</P>,
      },
      {
        id: 'both',
        heading: 'Running both',
        body: <P>Nothing stops you from having one agent on Claude and another on Codex. The triager will route work to whichever has been most relevant in the channel — or you can assign manually.</P>,
      },
    ],
  },

  {
    path: '/docs/agents/tools',
    group: 'Agents',
    title: 'Tools the agent can use',
    lede: <>Each agent has a list of capabilities. Toggle any of them off when you want the agent to stay in its lane.</>,
    sections: [
      {
        id: 'terminal',
        heading: 'Terminal',
        body: <P>The agent can run shell commands inside its own copy of your code. This is how it builds, runs tests, installs packages, and uses the language's own tooling. Almost every agent has this on.</P>,
      },
      {
        id: 'files',
        heading: 'Files',
        body: <P>Read and write files in the project's working directory. Required for any agent that edits code. The agent only sees files inside the project sandbox — it can't reach into other projects or your home folder.</P>,
      },
      {
        id: 'browser',
        heading: 'Browser',
        body: <P>A managed browser session. Useful for research, screenshot-driven QA, scraping, and tasks that involve reading actual web pages instead of hallucinating about them. Comes with a viewer so you can see what the agent sees, live.</P>,
      },
      {
        id: 'http',
        heading: 'HTTP',
        body: <P>The agent can make outbound HTTP requests to call APIs, fetch documentation, or pull data. Disable this if you want the agent to never reach the internet — useful for highly regulated environments.</P>,
      },
      {
        id: 'when-disable',
        heading: 'When to turn tools off',
        body: (
          <UL>
            <li><Em>Restricted networks</Em> — turn off HTTP and Browser if outbound network traffic from agent runs is restricted.</li>
            <li><Em>Speed</Em> — a research-only agent doesn't need Files or Terminal; turning them off makes it cheaper and faster.</li>
            <li><Em>Safety rails</Em> — a junior-engineer-style agent might not get HTTP at first.</li>
          </UL>
        ),
      },
    ],
  },

  {
    path: '/docs/agents/system-prompt',
    group: 'Agents',
    title: 'Writing the system prompt',
    lede: <>The system prompt is your agent's personality, taste, and rules. Keep it short, specific, and about your team's preferences — not about how to write code in general.</>,
    sections: [
      {
        id: 'good',
        heading: 'A good prompt is short and specific',
        body: (
          <>
            <P>Five to ten bullets is usually plenty. Focus on things that are unique to your team:</P>
            <UL>
              <li>The conventions you actually care about (file structure, naming, commit message style).</li>
              <li>The shortcuts you take repeatedly ("we use pnpm, not npm").</li>
              <li>The mistakes you keep correcting ("never edit migrations once they've shipped").</li>
              <li>The voice you want in PR descriptions and comments.</li>
            </UL>
          </>
        ),
      },
      {
        id: 'avoid',
        heading: 'What to avoid',
        body: (
          <UL>
            <li><Em>Don't put secrets in.</Em> Prompts are visible to anyone with access to the agent. Use service credentials instead.</li>
            <li><Em>Don't try to teach the model to code.</Em> The model already knows how to code; tell it your preferences instead.</li>
            <li><Em>Don't stuff in everything.</Em> A 2,000-word prompt makes the agent slower and more confused. Edit ruthlessly.</li>
          </UL>
        ),
      },
      {
        id: 'iterate',
        heading: 'Iterating',
        body: (
          <>
            <P>Treat the prompt as living. When you find yourself correcting the same mistake on every diff, add a line. When a rule never seems to bite, take it out.</P>
            <Callout>Look at the last ten jobs as a quick health check. If three of them needed the same correction, the prompt is missing something.</Callout>
          </>
        ),
      },
    ],
  },

  {
    path: '/docs/agents/reviewing',
    group: 'Agents',
    title: 'Reviewing the diff',
    lede: <>When an agent finishes, you decide what ships. The review tab is where most of your time with RunHQ will be spent.</>,
    sections: [
      {
        id: 'open',
        heading: 'Opening a review',
        body: (
          <>
            <P>When a todo flips to <Pill kind="review">Needs review</Pill>, you'll see a notification. Open the todo, then click the <Em>Diff</Em> tab.</P>
            <P>The diff shows every file the agent changed. Hover any line to add a comment.</P>
          </>
        ),
      },
      {
        id: 'three',
        heading: 'Three actions',
        body: (
          <UL>
            <li><Em>Approve</Em> — accept the change. RunHQ pushes the branch to your remote, ready to merge.</li>
            <li><Em>Request changes</Em> — leave comments, then send back. The agent picks up the same job and tries again with your feedback in context.</li>
            <li><Em>Discard</Em> — toss the work entirely. The worktree is cleaned up, the todo flips back to <Pill kind="pending">Pending</Pill>.</li>
          </UL>
        ),
      },
      {
        id: 'comments',
        heading: 'Comments on specific lines',
        body: <P>Click any line in the diff to add a line comment. These are passed verbatim to the agent on the next iteration — useful for "rename this", "add a test for X", "use the existing helper instead."</P>,
      },
      {
        id: 'retry',
        heading: 'Retrying with a different agent',
        body: <P>Sometimes the right answer is "let a different agent take a swing." From the diff view, click <Em>Retry with…</Em> and pick another agent. The new job inherits the original todo plus all your review comments.</P>,
      },
    ],
  },

  // ============================================================ Projects
  {
    path: '/docs/projects/settings',
    group: 'Projects',
    title: 'Project settings',
    lede: <>Project settings are where you change everything that's not a channel or a member. The settings tab lives at the top right of every project.</>,
    sections: [
      {
        id: 'basics',
        heading: 'Basics',
        body: (
          <UL>
            <li><Em>Name, icon, color</Em> — these show in the sidebar.</li>
            <li><Em>Sort order</Em> — drag projects in the sidebar to reorder; this saves automatically.</li>
            <li><Em>Working folder</Em> — where on disk agents check out code. Most teams leave the default.</li>
          </UL>
        ),
      },
      {
        id: 'sandbox',
        heading: 'Sandbox',
        body: (
          <>
            <P>The sandbox decides what the agent's terminal is allowed to do inside this project. New projects come with the sandbox turned on by default — agents can read and write inside the working folder, but not outside.</P>
            <P>Tighten or loosen it from the <Em>Sandbox</Em> section in project settings. Most teams never need to touch it.</P>
          </>
        ),
      },
      {
        id: 'members',
        heading: 'Members and roles',
        body: <P>By default, every workspace member has access to every project. Restrict access from the <Em>Members</Em> section — see <NL to="/docs/team/roles">Roles and permissions</NL>.</P>,
      },
      {
        id: 'delete',
        heading: 'Deleting a project',
        body: <P>Deleting is permanent and takes the channels and todos with it. Archive instead if you might want the history later — there's an <Em>Archive</Em> button next to <Em>Delete</Em>.</P>,
      },
    ],
  },

  {
    path: '/docs/projects/worktrees',
    group: 'Projects',
    title: 'Working folders and worktrees',
    lede: <>When an agent runs, it doesn't edit your code in place. It gets its own copy. This page explains how that works so you can make sense of what's happening on disk.</>,
    sections: [
      {
        id: 'why',
        heading: 'Why agents work in their own copy',
        body: (
          <>
            <P>Two reasons:</P>
            <UL>
              <li><Em>No collisions.</Em> If two agents are working at once, they don't fight over the same files.</li>
              <li><Em>Your local state stays clean.</Em> The agent never touches your editor's open files or your in-flight git changes.</li>
            </UL>
          </>
        ),
      },
      {
        id: 'how',
        heading: 'How it works',
        body: (
          <>
            <P>Every job opens with its own <Em>worktree</Em> — a separate checkout of the same repo, with its own branch. The agent runs there.</P>
            <P>You can think of it as: same repo, fresh folder, fresh branch, no shared state with anyone else.</P>
          </>
        ),
      },
      {
        id: 'lifecycle',
        heading: 'Lifecycle',
        body: (
          <UL>
            <li><Em>Job starts</Em> — RunHQ creates the worktree and a new branch.</li>
            <li><Em>Agent runs</Em> — all reads and writes go through this isolated copy.</li>
            <li><Em>You approve</Em> — RunHQ pushes the branch to your remote and cleans up the worktree.</li>
            <li><Em>You discard</Em> — RunHQ deletes the branch and the worktree. Nothing leaks.</li>
          </UL>
        ),
      },
      {
        id: 'find',
        heading: 'Finding the work on disk',
        body: <P>Worktrees live under your project's working folder, in a hidden <Em>worktrees</Em> subfolder named by job ID. Most of the time you won't need to look at them — the diff view shows everything. They're cleaned up automatically when the job closes.</P>,
      },
    ],
  },

  // ============================================================ Widget
  {
    path: '/docs/widget/overview',
    group: 'The widget',
    title: 'Capturing feedback with the widget',
    lede: <>Drop the widget on any page on your site. When users hit the feedback button, todos land in your project queue with their context already attached.</>,
    sections: [
      {
        id: 'what',
        heading: 'What it does',
        body: (
          <>
            <P>A small button (or any element you choose) opens the widget. The user types their feedback, optionally attaches a screenshot, and submits.</P>
            <P>RunHQ captures:</P>
            <UL>
              <li>The user's identity (whatever you pass in <Em>init</Em>).</li>
              <li>The page they were on, the browser, the screen size.</li>
              <li>Any console errors that happened in the session.</li>
              <li>An auto-generated screenshot if they don't add one.</li>
            </UL>
          </>
        ),
      },
      {
        id: 'flow',
        heading: 'What happens next',
        body: (
          <UL>
            <li>The widget files a todo in the channel you've configured.</li>
            <li>The triager picks the agent best matched for the work — see <NL to="/docs/widget/triager">How the triager picks an agent</NL>.</li>
            <li>If you've turned on auto-run, the agent starts immediately. Otherwise the todo waits in the queue.</li>
          </UL>
        ),
      },
      {
        id: 'privacy',
        heading: 'Privacy',
        body: (
          <>
            <P>Things to know:</P>
            <UL>
              <li>The widget never sends a private API token from the browser. Captures use a public ingest endpoint that's tied to your project ID.</li>
              <li>You control which user attributes are sent. By default, just the ID and email you pass to <Em>init</Em>.</li>
              <li>Screenshots are stored in your workspace, not on the widget CDN.</li>
            </UL>
          </>
        ),
      },
    ],
  },

  {
    path: '/docs/widget/install',
    group: 'The widget',
    title: 'Installing the widget',
    lede: <>Two script tags on any page. The widget mounts itself, captures viewport context, and posts back to your workspace.</>,
    sections: [
      {
        id: 'snippet',
        heading: 'Add the snippet',
        body: (
          <>
            <P>Drop these two tags into the <Em>head</Em> of any page on your site:</P>
            <Code>{`<script src="https://widget.runhq.io/v1.js"></script>
<script>
  RunHQ.init({
    project: "your-project-id",
    user: { id: "u_123", email: "ada@hover.dev" }
  });
</script>`}</Code>
            <P>Find your project ID in the project's <Em>Widget</Em> tab — it's a copy-paste away.</P>
          </>
        ),
      },
      {
        id: 'verify',
        heading: 'Verify it works',
        body: (
          <>
            <Steps>
              <li>Open the page in your browser.</li>
              <li>You should see a small feedback button in the bottom right.</li>
              <li>Click it, type "test feedback", submit.</li>
              <li>Check the project's todo channel — your test should appear within a few seconds.</li>
            </Steps>
          </>
        ),
      },
      {
        id: 'theme',
        heading: 'Matching your design',
        body: (
          <>
            <P>The widget renders inside an isolated frame so it can't fight your page styles. Override its look with a few CSS variables on your host page:</P>
            <UL>
              <li><Em>Accent color</Em> — set <Em>--runhq-accent</Em>.</li>
              <li><Em>Border radius</Em> — set <Em>--runhq-radius</Em>.</li>
              <li><Em>Position</Em> — set <Em>--runhq-pos</Em> (top-left, top-right, bottom-left, bottom-right).</li>
            </UL>
            <P>You can also replace the launcher button entirely — call <Em>RunHQ.open()</Em> from any of your own buttons.</P>
          </>
        ),
      },
    ],
  },

  {
    path: '/docs/widget/triager',
    group: 'The widget',
    title: 'How the triager picks an agent',
    lede: <>When a todo arrives via the widget, RunHQ scores your agents and picks one. Here's what the triager looks at — and how to override it.</>,
    sections: [
      {
        id: 'scoring',
        heading: 'How scoring works',
        body: (
          <>
            <P>For each agent in the channel's allowlist, the triager looks at:</P>
            <UL>
              <li><Em>Recent activity</Em> — how often this agent has worked in this channel lately.</li>
              <li><Em>Tool fit</Em> — does the agent have the tools the work probably needs?</li>
              <li><Em>Match with the message</Em> — a quick read of the todo content against the agent's prompt and history.</li>
            </UL>
            <P>The highest-scoring agent gets the work. Ties break on most-recent-activity.</P>
          </>
        ),
      },
      {
        id: 'allowlist',
        heading: 'Allowlist per channel',
        body: <P>By default, every agent in the project is eligible. If you want only certain agents to handle widget-captured feedback, set an allowlist in the channel's settings — only those agents will be considered.</P>,
      },
      {
        id: 'auto',
        heading: 'Auto-run vs review',
        body: (
          <UL>
            <li><Em>Review mode (default)</Em> — the triager picks an agent and assigns the todo. A human still hits Run.</li>
            <li><Em>Auto-run mode</Em> — the agent starts immediately. Best for low-stakes channels where you want fast turnaround.</li>
          </UL>
        ),
      },
      {
        id: 'override',
        heading: 'Overriding the triager',
        body: <P>Any teammate can manually reassign a todo to a different agent at any time — just open it and click <Em>Reassign</Em>. The triager won't override a manual assignment.</P>,
      },
    ],
  },

  // ============================================================ Workflows
  {
    path: '/docs/workflows',
    group: 'Workflows',
    title: 'Workflows: schedules and triggers',
    lede: <>Workflows are how you make work happen on a schedule or in response to an external event. Most teams don't use them on day one — but they unlock a lot once you do.</>,
    sections: [
      {
        id: 'when',
        heading: 'When workflows make sense',
        body: (
          <UL>
            <li><Em>Recurring chores</Em> — weekly dependency updates, daily security scans, nightly database snapshots.</li>
            <li><Em>Event-driven work</Em> — a failed deploy fires a webhook, an agent triages the failure.</li>
            <li><Em>Conversational automation</Em> — a chat channel that turns each message into a structured run.</li>
          </UL>
        ),
      },
      {
        id: 'triggers',
        heading: 'Triggers',
        body: (
          <UL>
            <li><Em>Cron</Em> — runs on a schedule. Standard cron syntax.</li>
            <li><Em>Webhook</Em> — runs when an external system POSTs to a unique URL.</li>
            <li><Em>Manual</Em> — you click Run.</li>
          </UL>
        ),
      },
      {
        id: 'enable',
        heading: 'Enabling workflows',
        body: <P>Workflows are an opt-in feature today. If you don't see the <Em>Workflows</Em> tab in your project, ask your workspace admin to enable it. Self-hosted workspaces enable it via a flag in their server config.</P>,
      },
      {
        id: 'first',
        heading: 'Building your first workflow',
        body: (
          <Steps>
            <li>Open the project where the work should happen.</li>
            <li>Click the <Em>Workflows</Em> tab. Hit <Em>+ New workflow</Em>.</li>
            <li>Pick a trigger — start with <Em>Manual</Em> while you're iterating.</li>
            <li>Add nodes: an Agent node to do the work, optional HTTP and conditional nodes for the rest.</li>
            <li>Save. Click Run to test.</li>
            <li>Once it works, switch the trigger to Cron or Webhook.</li>
          </Steps>
        ),
      },
    ],
  },

  // ============================================================ Team
  {
    path: '/docs/team/invites',
    group: 'Team & access',
    title: 'Inviting teammates',
    lede: <>RunHQ workspaces are usually one company or one team. Invite people via email and they'll join your existing workspace automatically.</>,
    sections: [
      {
        id: 'invite',
        heading: 'Sending an invite',
        body: (
          <Steps>
            <li>Click your avatar in the bottom left, then <Em>Workspace settings</Em>.</li>
            <li>Open the <Em>Members</Em> tab.</li>
            <li>Click <Em>Invite</Em>. Type one or more email addresses.</li>
            <li>Pick the role each invitee should join with — see <NL to="/docs/team/roles">Roles and permissions</NL>.</li>
            <li>Hit <Em>Send</Em>.</li>
          </Steps>
        ),
      },
      {
        id: 'auto-join',
        heading: 'Auto-join by domain',
        body: (
          <>
            <P>If you turn on <Em>Auto-join</Em>, anyone with an email at your verified company domain joins the workspace automatically when they sign up. Saves you from sending invites one at a time.</P>
            <P>You can still pick the default role for auto-joiners — most teams set this to <Em>Member</Em>.</P>
          </>
        ),
      },
      {
        id: 'remove',
        heading: 'Removing people',
        body: (
          <>
            <P>From the same Members tab, click <Em>•••</Em> next to a name and pick <Em>Remove from workspace</Em>. They lose access immediately. Their past activity stays in the audit log.</P>
            <Callout kind="warn">If you're removing someone who's the sole reviewer on an in-flight job, reassign the job first or it'll sit waiting.</Callout>
          </>
        ),
      },
    ],
  },

  {
    path: '/docs/team/roles',
    group: 'Team & access',
    title: 'Roles and permissions',
    lede: <>Three roles ship by default: Owner, Admin, and Member. You can override permissions per project for finer control.</>,
    sections: [
      {
        id: 'three',
        heading: 'The three default roles',
        body: (
          <UL>
            <li><Em>Owner</Em> — billing, dangerous things, can promote others to Owner. Usually the founder or a single trusted admin.</li>
            <li><Em>Admin</Em> — workspace settings, members, agents, integrations. Can do everything except change billing.</li>
            <li><Em>Member</Em> — the default. Can file todos, run jobs, comment, use channels — but can't change settings or invite people.</li>
          </UL>
        ),
      },
      {
        id: 'project',
        heading: 'Per-project overrides',
        body: (
          <>
            <P>Sometimes you want a teammate to be a <Em>Member</Em> in most of the workspace, but an <Em>Admin</Em> on one specific project. Open the project, then <Em>Members</Em>, and bump them up.</P>
            <P>Per-project overrides go either way — you can also restrict a Member to read-only on a sensitive project.</P>
          </>
        ),
      },
      {
        id: 'guests',
        heading: 'Guests and external reviewers',
        body: <P>Need to bring in a contractor or a customer for a single project? Invite them as a <Em>Member</Em> and restrict them to that project. They'll only see the projects you've explicitly given them access to.</P>,
      },
      {
        id: 'audit',
        heading: 'The audit log',
        body: <P>Every meaningful change — invites, role bumps, agent edits, jobs run — lands in the workspace audit log. Find it under <Em>Workspace settings → Audit</Em>. Owners and Admins can read it; Members can't.</P>,
      },
    ],
  },
];

// =============================================================================
// PAGES — Korean
// =============================================================================

const PAGES_KO: DocPage[] = [
  // ============================================================ 시작하기
  {
    path: '/docs',
    group: 'Get started',
    title: 'RunHQ에 오신 것을 환영합니다',
    lede: (
      <>RunHQ는 팀의 AI 코딩 에이전트가 실제로 일하는 곳입니다. 회의에서든, Slack 스레드든, 이메일이든, 사이트의 위젯이든 — 어디서나 할 일을 만들면 에이전트가 이어받아 변경을 작성하고, diff를 다시 사람의 리뷰로 넘깁니다. 워크스페이스 하나. 받은편지함 하나. 모든 기록이 한곳에 남습니다.</>
    ),
    hero: WELCOME_HERO_KO,
    sections: [],
    outro: WELCOME_OUTRO_KO,
  },

  {
    path: '/docs/sign-in',
    group: 'Get started',
    title: '처음 로그인하기',
    lede: <>이 과정은 한 번만 거치면 됩니다. 이후에는 로그인한 모든 기기에서 RunHQ가 사용자를 기억합니다.</>,
    sections: [
      {
        id: 'open',
        heading: '앱 열기',
        body: (
          <>
            <P>최신 브라우저로 <Em>app.runhq.io</Em>에 접속합니다. Google 또는 회사 이메일로 로그인하세요.</P>
            <P>회사에 이미 RunHQ 워크스페이스가 있다면, 이메일 도메인이 일치하는 경우 자동으로 합류합니다. 없다면 새 워크스페이스를 생성하라는 안내가 나타납니다.</P>
          </>
        ),
      },
      {
        id: 'lay',
        heading: '화면 둘러보기',
        body: (
          <>
            <P>사이드바에는 세 가지가 있습니다:</P>
            <UL>
              <li>맨 위의 <Em>프로젝트</Em> — 각각이 작업이 이루어지는 공간입니다. 새 워크스페이스에는 <Em>General</Em>이라는 기본 프로젝트가 들어 있습니다.</li>
              <li><Em>받은편지함</Em> — 아직 어떤 프로젝트에도 속하지 않은 할 일, 그리고 멘션과 답글이 모입니다.</li>
              <li>맨 아래의 <Em>설정</Em> — 프로필, 팀, 결제.</li>
            </UL>
            <P><Em>General</Em> 프로젝트를 열어보세요. 상단에 세 개의 채널이 보입니다: <Em>Todos</Em>, <Em>Browser</Em>, <Em>Chat</Em>. 모든 프로젝트의 기본 레이아웃입니다.</P>
          </>
        ),
      },
      {
        id: 'next',
        heading: '다음 단계',
        body: (
          <UL>
            <li>실제로 하고 싶은 작업을 위해 프로젝트를 만듭니다 — <NL to="/docs/first-project">첫 프로젝트</NL>를 참고하세요.</li>
            <li>또는 건너뛰고 General 프로젝트에서 할 일을 만들어 시험해 봅니다 — <NL to="/docs/first-todo">첫 할 일 만들기</NL>를 참고하세요.</li>
            <li>관리자라면 다른 작업을 시작하기 전에 <NL to="/docs/team/invites">팀원을 초대</NL>하는 편이 좋습니다.</li>
          </UL>
        ),
      },
    ],
  },

  {
    path: '/docs/first-project',
    group: 'Get started',
    title: '첫 프로젝트',
    lede: <>RunHQ의 모든 작업은 프로젝트 안에서 이루어집니다. 대부분의 팀은 리포지토리당 하나 또는 제품 영역당 하나로 운영합니다 — 팀이 평소 작업을 떠올리는 방식에 맞춰 선택하세요.</>,
    sections: [
      {
        id: 'create',
        heading: '프로젝트 만들기',
        body: (
          <>
            <Steps>
              <li>사이드바에서 <Em>Projects</Em> 옆의 <Em>+</Em> 버튼을 클릭합니다.</li>
              <li>프로젝트 이름을 정합니다 — 보통 리포지토리나 제품 영역 이름을 씁니다.</li>
              <li>아이콘과 색상을 고릅니다. 사이드바에서 프로젝트를 한눈에 구분할 수 있게 해줍니다.</li>
              <li>선택 사항: 폴더 이름을 지정합니다. 에이전트가 코드를 체크아웃하는 디스크상의 작업 디렉터리입니다.</li>
              <li><Em>Create</Em>를 클릭합니다.</li>
            </Steps>
          </>
        ),
      },
      {
        id: 'defaults',
        heading: '자동으로 설정되는 것',
        body: (
          <>
            <P>새 프로젝트에는 세 개의 채널이 기본으로 들어 있습니다:</P>
            <UL>
              <li><Em>Todos</Em> — 작업 큐. 대부분의 일이 여기로 모입니다.</li>
              <li><Em>Browser</Em> — 에이전트가 웹을 탐색해야 하는 작업용입니다.</li>
              <li><Em>Chat</Em> — 이 프로젝트의 에이전트와 자유롭게 대화하는 공간입니다.</li>
            </UL>
            <P>나중에 이름을 바꾸거나 추가하거나 쓰지 않는 채널을 보관할 수 있습니다. <NL to="/docs/channels/types">채널 유형</NL>을 참고하세요.</P>
          </>
        ),
      },
      {
        id: 'name',
        heading: '프로젝트 이름 짓기',
        body: (
          <>
            <P>대부분의 팀이 정착하는 두 가지 패턴:</P>
            <UL>
              <li><Em>리포지토리당 한 프로젝트.</Em> 직관적인 모델 — 프로젝트는 "리포지토리 X의 작업이 일어나는 곳"입니다.</li>
              <li><Em>제품 영역당 한 프로젝트.</Em> 하나의 리포가 여러 영역을 다루거나, 여러 리포가 하나의 제품을 이룰 때 더 적합합니다.</li>
            </UL>
            <Callout>나중에 채널을 재배정해 프로젝트 사이로 작업을 옮길 수 있습니다. 첫날부터 너무 고민하지 마세요.</Callout>
          </>
        ),
      },
    ],
  },

  {
    path: '/docs/first-todo',
    group: 'Get started',
    title: '첫 할 일 만들기',
    lede: <>할 일은 RunHQ의 작업 단위입니다. 팀의 누구나 만들 수 있습니다. 나중에 에이전트가 이어받거나, 직접 실행해도 됩니다.</>,
    sections: [
      {
        id: 'add',
        heading: '할 일 추가',
        body: (
          <>
            <Steps>
              <li>프로젝트의 <Em>Todos</Em> 채널을 엽니다.</li>
              <li>상단의 <Em>+ New todo</Em>를 클릭하거나 키보드의 <Kbd>N</Kbd>을 누릅니다.</li>
              <li>무엇을 바꿔야 하는지 알 수 있는 짧은 제목을 적습니다.</li>
              <li>도움이 된다면 설명, 스크린샷, 링크를 추가합니다. 첨부 파일은 바로 드래그 앤 드롭하면 됩니다.</li>
              <li><Em>File</Em>을 누릅니다.</li>
            </Steps>
            <P>할 일은 <Pill kind="pending">대기</Pill> 상태로 채널에 등록됩니다. 에이전트가 이어받으면 다음 단계로 넘어갑니다.</P>
          </>
        ),
      },
      {
        id: 'good',
        heading: '좋은 할 일의 모습',
        body: (
          <UL>
            <li><Em>제목</Em> — 동사로 시작하고 구체적으로. "Fix the password reset link on /login." 이 좋고, "login bug." 는 좋지 않습니다.</li>
            <li><Em>설명</Em> — 버그라면 재현 단계, 기능이라면 목표, 관련된 모든 링크를 포함하세요.</li>
            <li><Em>첨부 파일</Em> — 스크린샷은 거의 항상 에이전트가 더 나은 결과를 내게 해줍니다. 에러 메시지도 마찬가지입니다.</li>
          </UL>
        ),
      },
      {
        id: 'sources',
        heading: '할 일이 들어오는 경로',
        body: (
          <UL>
            <li><Em>팀원</Em> — 접근 권한이 있는 누구나 UI에서 바로 작성할 수 있습니다.</li>
            <li><Em>사용자</Em> — 사이트에 <NL to="/docs/widget/overview">위젯</NL>을 올리면 사용자가 직접 할 일을 남깁니다.</li>
            <li><Em>외부 도구</Em> — 웹훅으로 외부 이벤트를 자동으로 할 일로 변환합니다. <NL to="/docs/workflows">워크플로</NL>를 참고하세요.</li>
          </UL>
        ),
      },
    ],
  },

  {
    path: '/docs/run-agent',
    group: 'Get started',
    title: '첫 에이전트 실행하기',
    lede: <>할 일이 있다면, 에이전트를 돌리는 데는 클릭 한 번이면 됩니다. 무엇이 펼쳐지는지 살펴보세요.</>,
    sections: [
      {
        id: 'run',
        heading: 'Run 누르기',
        body: (
          <>
            <Steps>
              <li>방금 만든 할 일을 엽니다.</li>
              <li>우측 상단의 <Em>Run</Em>을 클릭합니다.</li>
              <li>에이전트를 고르거나 추천된 에이전트를 그대로 사용합니다 — RunHQ는 기본적으로 해당 채널에서 가장 활발한 에이전트를 추천합니다.</li>
              <li><Em>Start</Em>를 클릭합니다.</li>
            </Steps>
            <P>할 일은 <Pill kind="pending">대기</Pill>에서 <Pill kind="progress">진행 중</Pill>으로 바뀝니다. 해당 프로젝트의 <Em>Jobs</Em> 패널에 새 항목이 추가됩니다.</P>
          </>
        ),
      },
      {
        id: 'watching',
        heading: '무엇이 보이는가',
        body: (
          <>
            <P>실행 중인 잡을 엽니다. 세 개의 패널이 보입니다:</P>
            <UL>
              <li><Em>Terminal</Em> — 에이전트의 실시간 셸 세션. 작업이 진행되는 동안 출력이 스트리밍됩니다.</li>
              <li><Em>Chat</Em> — 사용자와 에이전트의 대화. 실행 중에도 끼어들어 추가 컨텍스트를 전달할 수 있습니다.</li>
              <li><Em>Files</Em> — 현재까지의 diff. 에이전트가 편집할 때마다 쌓여 갑니다.</li>
            </UL>
            <P>곁에서 지킬 필요는 없습니다. 잡은 자체 코드 복사본에서 실행되므로, 열어둔 작업물을 망가뜨릴 일이 없습니다.</P>
          </>
        ),
      },
      {
        id: 'finish',
        heading: '에이전트가 끝났을 때',
        body: (
          <>
            <P>할 일은 <Pill kind="review">리뷰</Pill> 상태로 바뀝니다. 알림을 받게 됩니다.</P>
            <P>잡의 <Em>Diff</Em> 탭을 열고 선택합니다:</P>
            <UL>
              <li><Em>Approve</Em> — 변경 사항을 승인합니다. RunHQ가 브랜치를 푸시합니다.</li>
              <li><Em>Request changes</Em> — 코멘트를 남기면 에이전트가 다시 시도합니다.</li>
              <li><Em>Discard</Em> — 작업을 폐기하고 새 할 일을 만듭니다.</li>
            </UL>
            <P>전체 리뷰 흐름은 <NL to="/docs/에이전트/reviewing">변경 사항 리뷰</NL>를 참고하세요.</P>
          </>
        ),
      },
    ],
  },

  // ============================================================ 할 일
  {
    path: '/docs/todos/creating',
    group: 'Todos',
    title: '할 일 만들기',
    lede: <>할 일은 어디서든 들어올 수 있습니다 — 앱, 위젯, 외부 시스템. 어디서 왔든 할 일 채널에 도착하면 모두 같은 모양으로 보입니다.</>,
    sections: [
      {
        id: 'in-app',
        heading: '앱에서',
        body: (
          <>
            <P>가장 빠른 경로입니다. 아무 할 일 채널에서나 <Em>+ New todo</Em>를 클릭하거나 <Kbd>N</Kbd>을 누릅니다. 제목과 설명, 선택적으로 첨부 파일을 더해 등록합니다.</P>
            <P>할 일을 만든 사용자는 보고자로 기록됩니다 — 할 일 화면과 감사 로그에서 확인할 수 있습니다.</P>
          </>
        ),
      },
      {
        id: 'widget',
        heading: '사이트의 위젯에서',
        body: (
          <>
            <P><NL to="/docs/widget/overview">위젯</NL>은 사용자 피드백을 자동으로 할 일로 만들어 줍니다. 사용자의 신원이 함께 첨부된 채로 지정한 채널에 도착합니다.</P>
            <P>대부분의 팀은 내부 작업과 분리해 트리아지할 수 있도록 위젯에서 들어온 피드백을 위한 별도 채널을 둡니다.</P>
          </>
        ),
      },
      {
        id: 'webhook',
        heading: '외부 이벤트에서',
        body: (
          <P>실패한 배포, 페이지 알림, 고객 이메일 — 웹훅으로 보낼 수 있는 모든 것이 할 일이 될 수 있습니다. <NL to="/docs/workflows">워크플로</NL>를 참고하세요.</P>
        ),
      },
      {
        id: 'attach',
        heading: '첨부 파일',
        body: (
          <>
            <P>이미지, PDF, 로그, zip 파일을 설명에 바로 드래그하세요. 에이전트는 텍스트와 함께 첨부 파일을 봅니다 — 특히 스크린샷이 큰 도움이 됩니다.</P>
            <Callout>할 일 설명이나 첨부 파일에 비밀 정보를 붙여 넣지 마세요. 할 일의 내용은 프로젝트 접근 권한이 있는 모든 사람에게 보입니다.</Callout>
          </>
        ),
      },
    ],
  },

  {
    path: '/docs/todos/lifecycle',
    group: 'Todos',
    title: '할 일의 라이프사이클',
    lede: <>에이전트가 작업하는 동안 할 일은 소수의 상태를 거쳐 움직입니다. 대부분의 전환은 자동으로 일어나며, 직접 표시해야 하는 경우는 몇 가지뿐입니다.</>,
    sections: [
      {
        id: 'states',
        heading: '상태 종류',
        body: (
          <>
            <UL>
              <li><Pill kind="pending">대기</Pill> — 아직 아무도 시작하지 않은 상태. 새 할 일의 기본값입니다.</li>
              <li><Pill kind="progress">진행 중</Pill> — 에이전트가 활발히 작업 중입니다.</li>
              <li><Pill kind="review">리뷰</Pill> — 에이전트가 작업을 마치고 사람을 기다리고 있습니다.</li>
              <li><Pill kind="done">완료</Pill> — 리뷰와 승인을 거쳐 브랜치가 머지된 상태입니다.</li>
              <li><Pill kind="deployed">배포됨</Pill> — 프로덕션에 배포된 상태입니다.</li>
              <li><Pill kind="cancelled">취소</Pill> — 배포 없이 종료된 상태입니다.</li>
            </UL>
          </>
        ),
      },
      {
        id: 'auto',
        heading: '자동으로 일어나는 일',
        body: (
          <>
            <P>RunHQ는 세 곳에서 상태를 자동으로 바꿉니다:</P>
            <UL>
              <li>에이전트가 잡을 시작하면 할 일은 <Pill kind="progress">진행 중</Pill>으로 바뀝니다.</li>
              <li>에이전트가 diff와 함께 멈추면 <Pill kind="review">리뷰</Pill>로 바뀝니다.</li>
              <li>diff를 승인하면 <Pill kind="done">완료</Pill>로 바뀝니다.</li>
            </UL>
          </>
        ),
      },
      {
        id: 'manual',
        heading: '직접 표시해야 하는 것',
        body: (
          <UL>
            <li><Pill kind="deployed">배포됨</Pill> — 변경 사항이 프로덕션에 반영되면 표시합니다. CI에 연동하는 팀도 있지만, 대부분은 직접 클릭합니다.</li>
            <li><Pill kind="cancelled">취소</Pill> — 더 이상 의미가 없는 할 일에 표시합니다. 감사 추적을 남기기 위해 삭제보다 취소가 권장됩니다.</li>
          </UL>
        ),
      },
    ],
  },

  {
    path: '/docs/todos/comments',
    group: 'Todos',
    title: '코멘트와 업보트',
    lede: <>할 일은 대화입니다. 알게 된 컨텍스트를 더하고, 중요한 항목에 투표하고, 실행 중에도 살짝 찔러 에이전트를 바른 길로 이끄세요.</>,
    sections: [
      {
        id: 'comments',
        heading: '코멘트',
        body: (
          <>
            <P>아무 할 일이나 열어보면 설명 아래에 코멘트 스레드가 보입니다. 메모, 질문, 재현 단계를 자유롭게 남기세요. 팀원에게 <Kbd>@</Kbd>를 사용해 멘션하면 알림이 갑니다.</P>
            <P>에이전트가 실행되는 동안 추가한 코멘트는 에이전트의 채팅에도 그대로 전달됩니다. 취소하고 다시 만들 필요 없이 실행 중에 새 정보를 줄 수 있는 방법입니다.</P>
          </>
        ),
      },
      {
        id: 'upvotes',
        heading: '업보트',
        body: (
          <>
            <P>각 할 일에는 업보트 버튼이 있습니다. 단순한 표시가 아닙니다:</P>
            <UL>
              <li>팀이 중요하게 여기는 것을 빠르게 드러냅니다 — 트리아지할 때 채널을 업보트 순으로 정렬해 보세요.</li>
              <li>자동 실행을 켜둔 경우, 트리아저는 무엇을 다음에 돌릴지 정할 때 업보트 수를 참고합니다.</li>
              <li>대화의 방향을 정돈합니다. 사람들은 자신이 중요하게 여기는 것에 업보트하므로, 팀과 사용자가 원하는 바를 볼 수 있습니다.</li>
            </UL>
          </>
        ),
      },
      {
        id: 'mentions',
        heading: '멘션과 알림',
        body: (
          <P><Kbd>@</Kbd>로 누군가를 멘션하면 알림이 전송됩니다(앱 내, 그리고 사용자가 켜둔 경우 이메일로도). 에이전트를 멘션하면 — <Kbd>@</Kbd>에이전트-name — 트리아저를 건너뛰고 즉시 그 에이전트에게 할 일이 배정됩니다.</P>
        ),
      },
    ],
  },

  // ============================================================ 채널
  {
    path: '/docs/channels/types',
    group: 'Channels',
    title: '채널 유형',
    lede: <>채널은 프로젝트 안에서 작업을 정돈합니다. 각 채널의 유형이 그 채널이 무엇을 위한 곳인지, 무엇을 할 수 있는지를 결정합니다.</>,
    sections: [
      {
        id: 'todo',
        heading: 'Todo',
        body: <P>작업 큐입니다. 기본 채널 유형이며, 대부분의 프로젝트가 가장 많은 시간을 보내는 곳입니다. 누구나 할 일을 만들 수 있고, 에이전트가 이어받아 실행합니다.</P>,
      },
      {
        id: 'chat',
        heading: 'Chat',
        body: <P>하나 이상의 에이전트와 자유롭게 대화하는 공간입니다. 브레인스토밍, 질문, 아직 구체적인 작업 단위로 정리되지 않은 일에 사용하세요. 여기서의 대화는 클릭 한 번으로 할 일로 승격할 수 있습니다.</P>,
      },
      {
        id: 'browser',
        heading: 'Browser',
        body: <P>에이전트가 웹을 탐색해야 하는 작업용입니다 — 리서치, 스크래핑, E2E 테스트. 에이전트는 사용자가 실시간으로 지켜볼 수 있는 관리형 브라우저 세션을 사용합니다.</P>,
      },
      {
        id: 'files',
        heading: 'Files',
        body: <P>프로젝트의 한 폴더로 바로 들어가 보는 화면입니다. 에이전트는 할 일을 거치지 않고 여기서 파일을 읽고 씁니다. 위키 형식의 노트, 설정, 데이터 파일처럼 할 일 모델에 맞지 않는 지속적인 편집에 유용합니다.</P>,
      },
      {
        id: 'workflow',
        heading: 'Workflow',
        body: <P>워크플로에 연결된 채널입니다. 채널의 메시지가 워크플로 실행이 됩니다 — 스크립트 기반 프로세스에 대화형 인터페이스를 붙이고 싶을 때 유용합니다. 고급 기능. <NL to="/docs/workflows">워크플로</NL>를 참고하세요.</P>,
      },
    ],
  },

  {
    path: '/docs/channels/organizing',
    group: 'Channels',
    title: '프로젝트 정리하기',
    lede: <>대부분의 팀은 Todos 채널 하나와 Chat 채널 하나만 두고 거기서 멈춥니다. 채널을 더 추가하는 게 합당한 경우는 다음과 같습니다.</>,
    sections: [
      {
        id: 'split-todos',
        heading: '할 일 채널을 나눌 때',
        body: (
          <>
            <P>두 번째 할 일 채널을 추가해야 할 때:</P>
            <UL>
              <li><Em>버그</Em>와 <Em>기능</Em>을 분리하고 각각에 다른 에이전트를 두고 싶을 때.</li>
              <li>위젯에서 들어온 외부 피드백을 메인 큐에 합치기 전에 별도로 트리아지하고 싶을 때.</li>
              <li>한 서브 팀이 특정 영역을 담당하고, 다른 곳의 소음이 보이지 않아야 할 때.</li>
            </UL>
            <P>큰 채널 하나 안에서 자꾸 필터링하고 싶어진다면, 채널을 나눠야 한다는 신호입니다.</P>
          </>
        ),
      },
      {
        id: 'browser-channel',
        heading: '브라우저 채널을 추가할 때',
        body: <P>웹 페이지를 들여다보는 작업에 에이전트를 쓰기 시작할 때 — 경쟁사 리서치, E2E 테스트 트리아지, 콘텐츠 점검. 브라우저 채널은 스크린샷과 트레이스를 대화와 함께 보관합니다.</P>,
      },
      {
        id: 'reorder',
        heading: '순서 변경과 이름 바꾸기',
        body: (
          <>
            <P>채널은 지정한 순서대로 표시됩니다. 프로젝트의 채널 목록(프로젝트 화면 상단의 줄)에서 드래그해 순서를 바꾸세요.</P>
            <P>채널의 설정 메뉴에서 이름을 변경할 수 있습니다. 이름을 바꿔도 링크는 깨지지 않습니다 — 기존 URL은 계속 동작합니다.</P>
          </>
        ),
      },
      {
        id: 'archive',
        heading: '보관',
        body: <P>더 이상 사용하지 않는 채널은 삭제하지 말고 보관하세요. 보관된 채널은 감사 로그에 그대로 남고 복원할 수 있습니다. 삭제는 영구적이며 기록을 함께 지웁니다.</P>,
      },
    ],
  },

  // ============================================================ agent
  {
    path: '/docs/agents/overview',
    group: 'Agents',
    title: '에이전트란 무엇인가',
    lede: <>에이전트는 AI인 팀원입니다. 이름, 그 뒤의 모델, 성격(시스템 프롬프트), 능력 집합(도구)을 갖춥니다.</>,
    sections: [
      {
        id: 'pieces',
        heading: '구성 요소',
        body: (
          <UL>
            <li><Em>이름과 아바타</Em> — 팀원들이 에이전트를 부르는 방식. <Kbd>@</Kbd>name으로 작업을 배정하거나, 채팅에서 호출하거나, 활동 로그에서 확인합니다.</li>
            <li><Em>모델</Em> — 실제로 뒤에서 동작하는 것. Claude Sonnet, Claude Haiku, OpenAI의 GPT 등.</li>
            <li><Em>시스템 프롬프트</Em> — 행동을 형성하는 지시사항. 팀의 목소리, 팀의 규칙.</li>
            <li><Em>도구</Em> — 무엇을 할 수 있는가. 터미널 명령 실행? 파일 편집? 브라우저 사용? 각각 켜고 끌 수 있습니다.</li>
          </UL>
        ),
      },
      {
        id: 'how-many',
        heading: '에이전트를 몇 개 만들지',
        body: (
          <>
            <P>대부분의 팀은 <Em>하나나 둘</Em>로 운영합니다. 트리아저는 에이전트 간 차이가 분명할 때 가장 잘 작동하며, 비슷한 에이전트가 십여 개 있을 때는 그렇지 않습니다.</P>
            <P>흔한 조합:</P>
            <UL>
              <li>코드 작업용 에이전트(Claude Code) 하나, 리서치용(브라우저 도구를 갖춘 범용) 하나.</li>
              <li>영역별로 하나씩: 백엔드 에이전트, 프런트엔드 에이전트.</li>
              <li>신중하고 깊이 있는 에이전트(Sonnet) 하나와 빠른 잔일용(Haiku) 하나.</li>
            </UL>
          </>
        ),
      },
      {
        id: 'persistence',
        heading: '에이전트가 지속적인 이유',
        body: <P>에이전트는 잡 사이에 과거 대화의 기억을 가지지 않습니다 — 매 잡은 새 출발입니다. 하지만 <Em>정체성</Em>은 유지됩니다: 배정 이력, 감사 추적, 시간에 따른 성능. 이 연속성이 "이 버그는 백엔드 에이전트가 가장 잘 다룬다"고 자신 있게 말할 수 있게 해줍니다.</P>,
      },
    ],
  },

  {
    path: '/docs/agents/claude-vs-codex',
    group: 'Agents',
    title: 'Claude Code와 Codex',
    lede: <>코딩 에이전트를 운영하는 두 가지 방법. 대부분의 팀은 Claude Code를 선택합니다. 이미 OpenAI에 표준화된 팀이라면 Codex가 잘 맞습니다.</>,
    sections: [
      {
        id: 'claude',
        heading: 'Claude Code',
        body: (
          <>
            <P>기본값이자 가장 흔한 선택입니다. Claude는 보통:</P>
            <UL>
              <li>더 작고 집중된 diff를 만듭니다.</li>
              <li>채팅에서 추론 과정을 단계별로 설명합니다.</li>
              <li>대규모 코드베이스에 강합니다 — 긴 컨텍스트, 적은 "중간 누락".</li>
            </UL>
            <P>대부분의 일을 잘하는 하나의 기본값을 원한다면 Claude Code를 고르세요.</P>
          </>
        ),
      },
      {
        id: 'codex',
        heading: 'Codex',
        body: (
          <>
            <P>OpenAI의 코딩 CLI로, 최신 모델 위에서 동작합니다. Codex는 보통:</P>
            <UL>
              <li>작고 범위가 명확한 작업에서 더 빠릅니다.</li>
              <li>간결한 출력을 선호합니다.</li>
              <li>이미 OpenAI에 비용을 쓰고 있는 팀에 잘 맞습니다.</li>
            </UL>
            <P>OpenAI에 표준화돼 있거나 Claude와 A/B 해보고 싶다면 Codex를 고르세요.</P>
          </>
        ),
      },
      {
        id: 'switching',
        heading: '나중에 바꾸기',
        body: <P>언제든지 에이전트의 모델을 바꿀 수 있습니다. 다음 잡부터 즉시 새 모델이 적용됩니다. 과거 잡 이력은 에이전트와 그대로 연결돼 있어, 모델을 바꿔도 초기화되지 않습니다.</P>,
      },
      {
        id: 'both',
        heading: '둘 다 운영하기',
        body: <P>한 에이전트는 Claude, 다른 에이전트는 Codex로 두는 데 아무 문제 없습니다. 트리아저는 채널에서 가장 관련 있는 쪽으로 작업을 보내며, 직접 배정해도 됩니다.</P>,
      },
    ],
  },

  {
    path: '/docs/agents/tools',
    group: 'Agents',
    title: '에이전트가 사용할 수 있는 도구',
    lede: <>각 에이전트에는 능력 목록이 있습니다. 에이전트가 자기 영역에 머물길 원할 때 어떤 도구든 꺼둘 수 있습니다.</>,
    sections: [
      {
        id: 'terminal',
        heading: 'Terminal',
        body: <P>에이전트는 자체 코드 복사본 안에서 셸 명령을 실행할 수 있습니다. 이것으로 빌드하고, 테스트를 돌리고, 패키지를 설치하고, 언어 고유의 도구를 사용합니다. 거의 모든 에이전트가 이 도구를 켜둡니다.</P>,
      },
      {
        id: 'files',
        heading: 'Files',
        body: <P>프로젝트 작업 디렉터리의 파일을 읽고 씁니다. 코드를 편집하는 모든 에이전트에 필요합니다. 에이전트는 프로젝트 샌드박스 안의 파일만 보며 — 다른 프로젝트나 홈 폴더에는 접근할 수 없습니다.</P>,
      },
      {
        id: 'browser',
        heading: 'Browser',
        body: <P>관리형 브라우저 세션입니다. 리서치, 스크린샷 기반 QA, 스크래핑, 그리고 실제 웹 페이지를 봐야 하는 작업(상상에 의존하지 않도록)에 유용합니다. 에이전트가 보는 화면을 실시간으로 볼 수 있는 뷰어가 함께 제공됩니다.</P>,
      },
      {
        id: 'http',
        heading: 'HTTP',
        body: <P>에이전트가 외부 HTTP 요청을 보내 API를 호출하거나, 문서를 가져오거나, 데이터를 받을 수 있습니다. 에이전트가 절대 인터넷에 닿지 않게 하려면 비활성화하세요 — 규제가 엄격한 환경에 유용합니다.</P>,
      },
      {
        id: 'when-disable',
        heading: '언제 도구를 끌까',
        body: (
          <UL>
            <li><Em>제한된 네트워크</Em> — 에이전트 실행에서 외부 트래픽이 제한돼 있다면 HTTP와 Browser를 끄세요.</li>
            <li><Em>속도</Em> — 리서치 전용 에이전트는 Files나 Terminal이 필요 없습니다; 끄면 더 저렴하고 빨라집니다.</li>
            <li><Em>안전 장치</Em> — 주니어 엔지니어 스타일의 에이전트에게 처음부터 HTTP를 주지 않는 식으로 운영할 수 있습니다.</li>
          </UL>
        ),
      },
    ],
  },

  {
    path: '/docs/agents/system-prompt',
    group: 'Agents',
    title: '시스템 프롬프트 작성',
    lede: <>시스템 프롬프트는 에이전트의 성격, 취향, 규칙입니다. 짧고 구체적으로, 그리고 일반적인 코딩 방법이 아니라 팀의 선호에 관해서만 적으세요.</>,
    sections: [
      {
        id: 'good',
        heading: '좋은 프롬프트는 짧고 구체적',
        body: (
          <>
            <P>5~10개의 불릿이면 보통 충분합니다. 팀에 고유한 내용에 집중하세요:</P>
            <UL>
              <li>실제로 신경 쓰는 컨벤션(파일 구조, 네이밍, 커밋 메시지 스타일).</li>
              <li>반복해서 쓰는 단축 규칙("우리는 npm이 아니라 pnpm을 씁니다").</li>
              <li>계속해서 바로잡는 실수("배포된 마이그레이션은 절대 수정하지 않는다").</li>
              <li>PR 설명과 코멘트에서 원하는 목소리.</li>
            </UL>
          </>
        ),
      },
      {
        id: 'avoid',
        heading: '피해야 할 것',
        body: (
          <UL>
            <li><Em>비밀 정보를 넣지 마세요.</Em> 프롬프트는 에이전트에 접근 권한이 있는 모두에게 보입니다. 대신 서비스 계정을 사용하세요.</li>
            <li><Em>모델에게 코딩을 가르치려 하지 마세요.</Em> 모델은 이미 코딩할 줄 압니다; 대신 팀의 선호를 알려주세요.</li>
            <li><Em>전부 다 욱여넣지 마세요.</Em> 2,000단어짜리 프롬프트는 에이전트를 느리고 헷갈리게 합니다. 가차 없이 다듬으세요.</li>
          </UL>
        ),
      },
      {
        id: 'iterate',
        heading: '반복해서 다듬기',
        body: (
          <>
            <P>프롬프트는 살아있는 문서로 다루세요. 매 diff마다 같은 실수를 바로잡고 있다면 한 줄 추가하세요. 한 번도 발동하지 않는 규칙이 있다면 빼세요.</P>
            <Callout>건강 점검 차원에서 최근 잡 10개를 살펴보세요. 그중 셋이 같은 수정이 필요했다면 프롬프트에 빠진 게 있다는 뜻입니다.</Callout>
          </>
        ),
      },
    ],
  },

  {
    path: '/docs/agents/reviewing',
    group: 'Agents',
    title: '변경 사항 리뷰',
    lede: <>에이전트가 작업을 마치면, 무엇을 배포할지는 사람이 결정합니다. RunHQ에서 가장 많은 시간을 보내는 곳이 바로 리뷰 탭입니다.</>,
    sections: [
      {
        id: 'open',
        heading: '리뷰 열기',
        body: (
          <>
            <P>할 일이 <Pill kind="review">리뷰</Pill>로 바뀌면 알림이 옵니다. 할 일을 열고 <Em>Diff</Em> 탭을 클릭하세요.</P>
            <P>diff에는 에이전트가 바꾼 모든 파일이 표시됩니다. 어느 줄에든 마우스를 올리면 코멘트를 달 수 있습니다.</P>
          </>
        ),
      },
      {
        id: 'three',
        heading: '세 가지 액션',
        body: (
          <UL>
            <li><Em>Approve</Em> — 변경을 승인합니다. RunHQ가 원격 저장소에 브랜치를 푸시해, 머지 준비가 끝납니다.</li>
            <li><Em>Request changes</Em> — 코멘트를 남기고 되돌립니다. 에이전트는 같은 잡을 이어받아 피드백을 컨텍스트에 포함한 채 다시 시도합니다.</li>
            <li><Em>Discard</Em> — 작업을 통째로 폐기합니다. 워크트리가 정리되고 할 일은 <Pill kind="pending">대기</Pill> 상태로 돌아갑니다.</li>
          </UL>
        ),
      },
      {
        id: 'comments',
        heading: '특정 줄에 코멘트',
        body: <P>diff에서 줄을 클릭하면 라인 코멘트를 달 수 있습니다. 이 코멘트는 다음 반복에서 에이전트에게 그대로 전달됩니다 — "이걸 이름 바꿔라", "X 테스트를 추가해라", "있는 헬퍼를 써라" 같은 지시에 유용합니다.</P>,
      },
      {
        id: 'retry',
        heading: '다른 에이전트로 재시도',
        body: <P>때로는 정답이 "다른 에이전트에게 맡겨 보자"일 때가 있습니다. diff 화면에서 <Em>Retry with…</Em>를 클릭해 다른 에이전트를 고르세요. 새 잡은 원래 할 일과 모든 리뷰 코멘트를 그대로 물려받습니다.</P>,
      },
    ],
  },

  // ============================================================ 프로젝트
  {
    path: '/docs/projects/settings',
    group: 'Projects',
    title: '프로젝트 설정',
    lede: <>프로젝트 설정은 채널이나 멤버가 아닌 모든 것을 바꾸는 곳입니다. 설정 탭은 모든 프로젝트의 우측 상단에 있습니다.</>,
    sections: [
      {
        id: 'basics',
        heading: '기본 설정',
        body: (
          <UL>
            <li><Em>이름, 아이콘, 색상</Em> — 사이드바에 표시됩니다.</li>
            <li><Em>정렬 순서</Em> — 사이드바에서 프로젝트를 드래그해 순서를 바꾸면 자동으로 저장됩니다.</li>
            <li><Em>작업 폴더</Em> — 에이전트가 코드를 체크아웃하는 디스크 위치. 대부분의 팀은 기본값을 그대로 사용합니다.</li>
          </UL>
        ),
      },
      {
        id: 'sandbox',
        heading: '샌드박스',
        body: (
          <>
            <P>샌드박스는 이 프로젝트 안에서 에이전트의 터미널이 무엇을 할 수 있는지를 결정합니다. 새 프로젝트는 기본적으로 샌드박스가 켜진 상태로 시작합니다 — 에이전트는 작업 폴더 안에서만 읽고 쓸 수 있으며, 바깥은 건드릴 수 없습니다.</P>
            <P>프로젝트 설정의 <Em>Sandbox</Em> 섹션에서 더 엄격하게 또는 느슨하게 조절할 수 있습니다. 대부분의 팀은 손댈 일이 없습니다.</P>
          </>
        ),
      },
      {
        id: 'members',
        heading: '멤버와 역할',
        body: <P>기본적으로 모든 워크스페이스 멤버는 모든 프로젝트에 접근할 수 있습니다. <Em>Members</Em> 섹션에서 접근을 제한할 수 있습니다 — <NL to="/docs/team/roles">역할과 권한</NL>을 참고하세요.</P>,
      },
      {
        id: 'delete',
        heading: '프로젝트 삭제',
        body: <P>삭제는 영구적이며 채널과 할 일까지 함께 사라집니다. 나중에 기록이 필요할 수 있다면 대신 보관하세요 — <Em>Delete</Em> 옆에 <Em>Archive</Em> 버튼이 있습니다.</P>,
      },
    ],
  },

  {
    path: '/docs/projects/worktrees',
    group: 'Projects',
    title: '작업 폴더와 워크트리',
    lede: <>에이전트가 실행될 때 코드를 그 자리에서 편집하지 않습니다. 자체 복사본을 가지고 작업합니다. 디스크에서 일어나는 일을 이해할 수 있도록 그 구조를 설명합니다.</>,
    sections: [
      {
        id: 'why',
        heading: '왜 자체 복사본에서 작업하는가',
        body: (
          <>
            <P>두 가지 이유입니다:</P>
            <UL>
              <li><Em>충돌 방지.</Em> 두 에이전트가 동시에 작업해도 같은 파일을 두고 다투지 않습니다.</li>
              <li><Em>로컬 상태 보존.</Em> 에이전트는 에디터의 열린 파일이나 진행 중인 git 변경을 절대 건드리지 않습니다.</li>
            </UL>
          </>
        ),
      },
      {
        id: 'how',
        heading: '동작 방식',
        body: (
          <>
            <P>모든 잡은 자체 <Em>워크트리</Em>로 시작합니다 — 같은 리포의 별도 체크아웃과 자체 브랜치를 가집니다. 에이전트는 그 안에서 동작합니다.</P>
            <P>같은 리포, 새 폴더, 새 브랜치, 다른 누구와도 공유되지 않는 상태라고 생각하면 됩니다.</P>
          </>
        ),
      },
      {
        id: 'lifecycle',
        heading: '라이프사이클',
        body: (
          <UL>
            <li><Em>잡 시작</Em> — RunHQ가 워크트리와 새 브랜치를 만듭니다.</li>
            <li><Em>에이전트 실행</Em> — 모든 읽기와 쓰기는 이 격리된 복사본을 통해 일어납니다.</li>
            <li><Em>승인</Em> — RunHQ가 브랜치를 원격에 푸시하고 워크트리를 정리합니다.</li>
            <li><Em>폐기</Em> — RunHQ가 브랜치와 워크트리를 삭제합니다. 새는 것은 없습니다.</li>
          </UL>
        ),
      },
      {
        id: 'find',
        heading: '디스크에서 작업 위치 찾기',
        body: <P>워크트리는 프로젝트의 작업 폴더 아래, 잡 ID로 이름 붙은 숨김 <Em>worktrees</Em> 하위 폴더에 있습니다. 대개는 직접 들여다볼 일이 없습니다 — diff 화면에서 모두 확인할 수 있고, 잡이 끝나면 자동으로 정리됩니다.</P>,
      },
    ],
  },

  // ============================================================ 위젯
  {
    path: '/docs/widget/overview',
    group: 'The widget',
    title: '위젯으로 피드백 받기',
    lede: <>사이트의 아무 페이지에나 위젯을 올려두세요. 사용자가 피드백 버튼을 누르면 할 일이 컨텍스트가 첨부된 채로 프로젝트 큐에 도착합니다.</>,
    sections: [
      {
        id: 'what',
        heading: '하는 일',
        body: (
          <>
            <P>작은 버튼(또는 원하는 어떤 요소든)이 위젯을 엽니다. 사용자가 피드백을 입력하고, 선택적으로 스크린샷을 첨부한 뒤 제출합니다.</P>
            <P>RunHQ가 함께 수집하는 정보:</P>
            <UL>
              <li>사용자의 신원(<Em>init</Em>에 전달한 값 기준).</li>
              <li>접속한 페이지, 브라우저, 화면 크기.</li>
              <li>세션 중 발생한 콘솔 에러.</li>
              <li>사용자가 스크린샷을 직접 첨부하지 않은 경우 자동 생성된 스크린샷.</li>
            </UL>
          </>
        ),
      },
      {
        id: 'flow',
        heading: '그다음에 일어나는 일',
        body: (
          <UL>
            <li>위젯이 지정한 채널에 할 일을 만듭니다.</li>
            <li>트리아저가 해당 작업에 가장 잘 맞는 에이전트를 고릅니다 — <NL to="/docs/widget/triager">트리아저가 에이전트를 고르는 방식</NL>을 참고하세요.</li>
            <li>자동 실행을 켜둔 경우 에이전트가 즉시 시작합니다. 아니라면 할 일이 큐에 대기합니다.</li>
          </UL>
        ),
      },
      {
        id: 'privacy',
        heading: '개인정보',
        body: (
          <>
            <P>알아둘 점:</P>
            <UL>
              <li>위젯은 절대 브라우저에서 비공개 API 토큰을 보내지 않습니다. 캡처는 프로젝트 ID에 매여 있는 공개 인제스트 엔드포인트를 사용합니다.</li>
              <li>어떤 사용자 속성을 보낼지 직접 통제할 수 있습니다. 기본값은 <Em>init</Em>에 전달한 ID와 이메일뿐입니다.</li>
              <li>스크린샷은 위젯 CDN이 아니라 워크스페이스에 저장됩니다.</li>
            </UL>
          </>
        ),
      },
    ],
  },

  {
    path: '/docs/widget/install',
    group: 'The widget',
    title: '위젯 설치',
    lede: <>아무 페이지에 스크립트 태그 두 줄. 위젯은 스스로 마운트되고, 뷰포트 컨텍스트를 캡처해 워크스페이스로 전송합니다.</>,
    sections: [
      {
        id: 'snippet',
        heading: '스니펫 추가',
        body: (
          <>
            <P>사이트의 아무 페이지든 <Em>head</Em>에 다음 두 태그를 넣으세요:</P>
            <Code>{`<script src="https://widget.runhq.io/v1.js"></script>
<script>
  RunHQ.init({
    project: "your-project-id",
    user: { id: "u_123", email: "ada@hover.dev" }
  });
</script>`}</Code>
            <P>프로젝트 ID는 프로젝트의 <Em>Widget</Em> 탭에서 확인할 수 있습니다 — 복사해서 붙여넣기만 하면 됩니다.</P>
          </>
        ),
      },
      {
        id: 'verify',
        heading: '동작 확인',
        body: (
          <>
            <Steps>
              <li>브라우저에서 해당 페이지를 엽니다.</li>
              <li>우측 하단에 작은 피드백 버튼이 보여야 합니다.</li>
              <li>클릭해서 "test feedback"을 입력하고 제출합니다.</li>
              <li>프로젝트의 할 일 채널을 확인하세요 — 테스트 항목이 몇 초 안에 보여야 합니다.</li>
            </Steps>
          </>
        ),
      },
      {
        id: 'theme',
        heading: '디자인 맞추기',
        body: (
          <>
            <P>위젯은 격리된 프레임 안에서 렌더링돼 호스트 페이지의 스타일과 충돌하지 않습니다. 호스트 페이지에 다음 CSS 변수 몇 가지를 지정해 외형을 조정하세요:</P>
            <UL>
              <li><Em>강조 색상</Em> — <Em>--runhq-accent</Em>를 설정합니다.</li>
              <li><Em>모서리 반경</Em> — <Em>--runhq-radius</Em>를 설정합니다.</li>
              <li><Em>위치</Em> — <Em>--runhq-pos</Em>를 설정합니다(top-left, top-right, bottom-left, bottom-right).</li>
            </UL>
            <P>런처 버튼 자체를 교체할 수도 있습니다 — 사용자 측 버튼에서 <Em>RunHQ.open()</Em>을 호출하세요.</P>
          </>
        ),
      },
    ],
  },

  {
    path: '/docs/widget/triager',
    group: 'The widget',
    title: '트리아저가 에이전트를 고르는 방식',
    lede: <>위젯을 통해 할 일이 도착하면 RunHQ는 에이전트를 점수화해 하나를 고릅니다. 트리아저가 무엇을 보는지 — 그리고 어떻게 재정의할지 살펴보세요.</>,
    sections: [
      {
        id: 'scoring',
        heading: '점수 계산 방식',
        body: (
          <>
            <P>채널의 허용 목록에 있는 각 에이전트에 대해 트리아저는 다음을 살핍니다:</P>
            <UL>
              <li><Em>최근 활동</Em> — 이 에이전트가 최근 이 채널에서 얼마나 자주 일했는가.</li>
              <li><Em>도구 적합도</Em> — 이 작업에 필요해 보이는 도구를 에이전트가 갖고 있는가.</li>
              <li><Em>메시지와의 일치도</Em> — 할 일 내용을 에이전트의 프롬프트와 이력에 비추어 빠르게 평가합니다.</li>
            </UL>
            <P>가장 높은 점수를 받은 에이전트가 작업을 가져갑니다. 동점이면 가장 최근에 활동한 쪽이 우선합니다.</P>
          </>
        ),
      },
      {
        id: 'allowlist',
        heading: '채널별 허용 목록',
        body: <P>기본적으로 프로젝트의 모든 에이전트가 후보입니다. 특정 에이전트만 위젯에서 들어온 피드백을 다루게 하려면 채널 설정에서 허용 목록을 지정하세요 — 그 에이전트들만 후보가 됩니다.</P>,
      },
      {
        id: 'auto',
        heading: '자동 실행과 리뷰',
        body: (
          <UL>
            <li><Em>리뷰 모드(기본)</Em> — 트리아저가 에이전트를 골라 할 일을 배정합니다. 사람이 직접 Run을 누릅니다.</li>
            <li><Em>자동 실행 모드</Em> — 에이전트가 즉시 시작합니다. 빠른 회전이 필요한 낮은 위험 채널에 적합합니다.</li>
          </UL>
        ),
      },
      {
        id: 'override',
        heading: '트리아저 재정의',
        body: <P>팀원 누구나 언제든지 할 일을 수동으로 다른 에이전트에게 재배정할 수 있습니다 — 할 일을 열고 <Em>Reassign</Em>을 클릭하면 됩니다. 트리아저는 수동 배정을 덮어쓰지 않습니다.</P>,
      },
    ],
  },

  // ============================================================ 워크플로
  {
    path: '/docs/workflows',
    group: 'Workflows',
    title: '워크플로: 스케줄과 트리거',
    lede: <>워크플로는 작업이 스케줄에 따라, 또는 외부 이벤트에 반응해 일어나도록 만드는 방법입니다. 첫날부터 쓰는 팀은 많지 않지만, 한번 익히면 많은 것이 열립니다.</>,
    sections: [
      {
        id: 'when',
        heading: '워크플로가 적합한 경우',
        body: (
          <UL>
            <li><Em>반복 잡일</Em> — 주간 의존성 업데이트, 일일 보안 스캔, 야간 데이터베이스 스냅샷.</li>
            <li><Em>이벤트 기반 작업</Em> — 실패한 배포가 웹훅을 발사하고, 에이전트가 실패를 트리아지합니다.</li>
            <li><Em>대화형 자동화</Em> — 각 메시지를 구조화된 실행으로 바꾸는 채팅 채널.</li>
          </UL>
        ),
      },
      {
        id: 'triggers',
        heading: '트리거',
        body: (
          <UL>
            <li><Em>Cron</Em> — 스케줄로 실행됩니다. 표준 cron 문법.</li>
            <li><Em>Webhook</Em> — 외부 시스템이 고유 URL로 POST하면 실행됩니다.</li>
            <li><Em>수동</Em> — 사용자가 Run을 클릭합니다.</li>
          </UL>
        ),
      },
      {
        id: 'enable',
        heading: '워크플로 활성화',
        body: <P>워크플로는 현재 옵트인 기능입니다. 프로젝트에 <Em>Workflows</Em> 탭이 보이지 않으면 워크스페이스 관리자에게 활성화를 요청하세요. 셀프 호스팅 워크스페이스는 서버 설정의 플래그로 활성화합니다.</P>,
      },
      {
        id: 'first',
        heading: '첫 워크플로 만들기',
        body: (
          <Steps>
            <li>작업이 일어날 프로젝트를 엽니다.</li>
            <li><Em>Workflows</Em> 탭을 클릭합니다. <Em>+ New workflow</Em>를 누릅니다.</li>
            <li>트리거를 고릅니다 — 다듬는 동안은 <Em>Manual</Em>로 시작하세요.</li>
            <li>노드를 추가합니다: 작업을 수행할 Agent 노드, 필요에 따라 HTTP와 조건 노드.</li>
            <li>저장합니다. Run을 클릭해 테스트합니다.</li>
            <li>잘 동작하면 트리거를 Cron이나 Webhook으로 바꿉니다.</li>
          </Steps>
        ),
      },
    ],
  },

  // ============================================================ 팀
  {
    path: '/docs/team/invites',
    group: 'Team & access',
    title: '팀원 초대',
    lede: <>RunHQ 워크스페이스는 보통 하나의 회사 또는 하나의 팀입니다. 이메일로 초대하면, 이미 있는 워크스페이스에 자동으로 합류합니다.</>,
    sections: [
      {
        id: 'invite',
        heading: '초대 보내기',
        body: (
          <Steps>
            <li>좌측 하단의 아바타를 클릭하고 <Em>Workspace settings</Em>를 엽니다.</li>
            <li><Em>Members</Em> 탭을 엽니다.</li>
            <li><Em>Invite</Em>를 클릭합니다. 이메일 주소를 하나 이상 입력하세요.</li>
            <li>초대받는 사람이 합류할 역할을 고릅니다 — <NL to="/docs/team/roles">역할과 권한</NL>을 참고하세요.</li>
            <li><Em>Send</Em>를 누릅니다.</li>
          </Steps>
        ),
      },
      {
        id: 'auto-join',
        heading: '도메인 자동 합류',
        body: (
          <>
            <P><Em>Auto-join</Em>을 켜두면, 인증된 회사 도메인의 이메일로 가입한 사람이 자동으로 워크스페이스에 합류합니다. 일일이 초대를 보내지 않아도 됩니다.</P>
            <P>자동 합류자에게 적용할 기본 역할도 지정할 수 있습니다 — 대부분의 팀은 이를 <Em>Member</Em>로 둡니다.</P>
          </>
        ),
      },
      {
        id: 'remove',
        heading: '구성원 제거',
        body: (
          <>
            <P>같은 Members 탭에서 이름 옆의 <Em>•••</Em>를 클릭한 뒤 <Em>Remove from workspace</Em>를 선택합니다. 접근 권한은 즉시 사라집니다. 과거 활동은 감사 로그에 그대로 남습니다.</P>
            <Callout kind="warn">진행 중인 잡의 유일한 리뷰어를 제거하는 경우, 먼저 잡을 재배정하세요. 그렇지 않으면 잡이 대기 상태로 멈춥니다.</Callout>
          </>
        ),
      },
    ],
  },

  {
    path: '/docs/team/roles',
    group: 'Team & access',
    title: '역할과 권한',
    lede: <>기본 역할은 세 가지입니다: Owner, Admin, Member. 더 세밀한 통제를 위해 프로젝트별로 권한을 재정의할 수 있습니다.</>,
    sections: [
      {
        id: 'three',
        heading: '세 가지 기본 역할',
        body: (
          <UL>
            <li><Em>Owner</Em> — 결제, 위험한 작업, 다른 사람을 Owner로 승격할 수 있습니다. 보통 창업자 또는 신뢰받는 단일 관리자입니다.</li>
            <li><Em>Admin</Em> — 워크스페이스 설정, 멤버, 에이전트, 통합. 결제 변경을 제외한 거의 모든 일을 할 수 있습니다.</li>
            <li><Em>Member</Em> — 기본값. 할 일을 만들고, 잡을 실행하고, 코멘트를 달고, 채널을 사용할 수 있지만, 설정을 바꾸거나 다른 사람을 초대할 수는 없습니다.</li>
          </UL>
        ),
      },
      {
        id: 'project',
        heading: '프로젝트별 재정의',
        body: (
          <>
            <P>한 팀원을 워크스페이스 전반에서는 <Em>Member</Em>로 두고, 특정 프로젝트에서만 <Em>Admin</Em>으로 두고 싶을 때가 있습니다. 그 프로젝트를 열고 <Em>Members</Em>에서 권한을 올리세요.</P>
            <P>프로젝트별 재정의는 양방향입니다 — 민감한 프로젝트에서는 Member를 읽기 전용으로 제한할 수도 있습니다.</P>
          </>
        ),
      },
      {
        id: 'guests',
        heading: '게스트와 외부 리뷰어',
        body: <P>한 프로젝트에만 외주 작업자나 고객을 들여야 한다면 <Em>Member</Em>로 초대한 뒤 해당 프로젝트로만 권한을 제한하세요. 명시적으로 접근 권한을 준 프로젝트만 보입니다.</P>,
      },
      {
        id: 'audit',
        heading: '감사 로그',
        body: <P>의미 있는 모든 변경 — 초대, 역할 변경, 에이전트 편집, 잡 실행 — 은 워크스페이스 감사 로그에 남습니다. <Em>Workspace settings → Audit</Em>에서 찾을 수 있습니다. Owner와 Admin은 읽을 수 있고 Member는 읽을 수 없습니다.</P>,
      },
    ],
  },
];

// =============================================================================
// Layout
// =============================================================================

function buildSidebar(pages: DocPage[]) {
  const groups: Record<Group, DocPage[]> = {
    'Get started': [],
    'Todos': [],
    'Channels': [],
    'Agents': [],
    'Projects': [],
    'The widget': [],
    'Workflows': [],
    'Team & access': [],
  };
  for (const p of pages) groups[p.group].push(p);
  return groups;
}

function PrevNext({ pages, idx }: { pages: DocPage[]; idx: number }) {
  const t = useT(DOCS_T);
  const prev = idx > 0 ? pages[idx - 1] : null;
  const next = idx < pages.length - 1 ? pages[idx + 1] : null;
  if (!prev && !next) return null;
  return (
    <nav className="rhpd-prevnext">
      {prev ? (
        <Link to={prev.path} className="rhpd-pn rhpd-pn-prev">
          <span className="rhpd-pn-arrow">←</span>
          <span>
            <span className="rhpd-pn-kicker mono">{t.prevLabel}</span>
            <span className="rhpd-pn-title">{prev.title}</span>
          </span>
        </Link>
      ) : <span />}
      {next ? (
        <Link to={next.path} className="rhpd-pn rhpd-pn-next">
          <span>
            <span className="rhpd-pn-kicker mono">{t.nextLabel}</span>
            <span className="rhpd-pn-title">{next.title}</span>
          </span>
          <span className="rhpd-pn-arrow">→</span>
        </Link>
      ) : <span />}
    </nav>
  );
}

function HelpBlock() {
  const t = useT(DOCS_T);
  return (
    <div className="rhpd-help">
      <div>
        <div className="rhpd-help-h">{t.helpH}</div>
        <p className="rhpd-help-p">{t.helpP}</p>
      </div>
      <div className="rhpd-help-r">
        <a className="rhp-btn-ghost" href={SIGNUP_URL}>{t.helpOpenChat}</a>
        <a className="rhp-btn-primary" href="mailto:admin@runhq.io">{t.helpEmail}</a>
      </div>
    </div>
  );
}

function SearchBar({ query, setQuery }: { query: string; setQuery: (q: string) => void }) {
  const t = useT(DOCS_T);
  return (
    <div className="rhpd-side-search">
      <span>⌕</span>
      <input
        placeholder={t.searchPlaceholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {query && <button className="rhpd-side-clear" onClick={() => setQuery('')} aria-label={t.searchClear}>×</button>}
    </div>
  );
}

function Sidebar({ pages, currentPath, query, setQuery }: { pages: DocPage[]; currentPath: string; query: string; setQuery: (q: string) => void }) {
  const locale = useLocale();
  const groups = useMemo(() => buildSidebar(pages), [pages]);
  const q = query.trim().toLowerCase();
  return (
    <aside className="rhpd-side">
      <SearchBar query={query} setQuery={setQuery} />
      <nav className="rhpd-side-nav">
        {GROUP_ORDER.map((g) => {
          const items = groups[g].filter((p) => !q || p.title.toLowerCase().includes(q));
          if (items.length === 0) return null;
          return (
            <div key={g} className="rhpd-side-sec">
              <div className="rhpd-side-h">{GROUP_LABEL[locale][g]}</div>
              {items.map((p) => (
                <Link
                  key={p.path}
                  to={p.path}
                  className={`rhpd-side-i ${p.path === currentPath ? 'rhpd-side-on' : ''}`}
                >
                  {p.title}
                </Link>
              ))}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}

function Toc({ page, activeId }: { page: DocPage; activeId: string | null }) {
  const t = useT(DOCS_T);
  const items = page.sections.map((s) => ({ id: s.id, label: s.heading }));
  if (items.length === 0) return null;
  return (
    <aside className="rhpd-toc">
      <div className="rhpd-toc-h mono">{t.onThisPage}</div>
      {items.map((i) => (
        <a
          key={i.id}
          href={`#${i.id}`}
          className={`rhpd-toc-i ${activeId === i.id ? 'rhpd-toc-on' : ''}`}
        >
          {i.label}
        </a>
      ))}
      <div className="rhpd-toc-meta mono">{t.tocMeta}</div>
    </aside>
  );
}

function useActiveSection(ids: string[]) {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  useEffect(() => {
    if (ids.length === 0) return;
    const visible = new Set<string>();
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        }
        const first = ids.find((id) => visible.has(id));
        if (first) setActive(first);
      },
      { rootMargin: '-30% 0px -55% 0px', threshold: 0 }
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) obs.observe(el);
    }
    return () => obs.disconnect();
  }, [ids.join('|')]);
  return active;
}

// =============================================================================
// Main page
// =============================================================================

export default function DocsPage() {
  const loc = useLocation();
  const locale = useLocale();
  const t = useT(DOCS_T);

  // Normalize the trailing slash before matching against the page registry paths.
  const path = loc.pathname.replace(/\/+$/, '') || '/docs';

  const pages = locale === 'ko' ? PAGES_KO : PAGES_EN;
  const idx = pages.findIndex((p) => p.path === path);
  const page = idx >= 0 ? pages[idx] : null;

  const [query, setQuery] = useState('');
  const sectionIds = page?.sections.map((s) => s.id) ?? [];
  const activeId = useActiveSection(sectionIds);

  return (
    <div className="rhp-root rhpd-root">
      <style>{DOCS_STYLES}</style>
      <Navbar active="docs" />

      <div className="rhpd-shell">
        <Sidebar pages={pages} currentPath={path} query={query} setQuery={setQuery} />

        <main className="rhpd-main">
          {page ? (
            <>
              <div className="rhpd-crumbs mono">
                <Link to="/docs">{t.crumbsDocs}</Link>
                <span>/</span>
                <span>{GROUP_LABEL[locale][page.group]}</span>
                <span>/</span>
                <span className="rhpd-cur">{page.title}</span>
              </div>

              <h1 className="rhpd-h1">{page.title}</h1>
              {page.lede && <p className="rhpd-lede">{page.lede}</p>}

              {page.hero}

              {page.sections.map((s) => (
                <section key={s.id} className="rhpd-sec">
                  <h2 className="rhpd-h2" id={s.id}>{s.heading}</h2>
                  {s.body}
                </section>
              ))}

              {page.outro}

              <PrevNext pages={pages} idx={idx} />
              <HelpBlock />
            </>
          ) : (
            <div className="rhpd-404">
              <div className="rhpd-crumbs mono">
                <Link to="/docs">{t.crumbsDocs}</Link>
                <span>/</span>
                <span className="rhpd-cur">{t.crumbsNotFound}</span>
              </div>
              <h1 className="rhpd-h1">{t.notFoundH1}</h1>
              <p className="rhpd-lede">{t.notFoundLedePre}<Link className="rhpd-link" to="/docs">{t.notFoundLedeLink}</Link>{t.notFoundLedeSuffix}</p>
            </div>
          )}
        </main>

        {page && <Toc page={page} activeId={activeId} />}
      </div>

      <Footer />
    </div>
  );
}

// =============================================================================
// Styles
// =============================================================================

const DOCS_STYLES = `
  .rhp-root {
    background: var(--rhw-bg);
    color: var(--rhw-ink);
    font-family: 'Geist', 'Inter Tight', system-ui, sans-serif;
    font-size: 15px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    min-height: 100vh;
  }
  .rhp-root *, .rhp-root *::before, .rhp-root *::after { box-sizing: border-box; }
  .rhp-root a { color: inherit; text-decoration: none; }

  .rhp-btn-primary {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 11px 20px;
    background: var(--rhw-ink); color: #fff !important;
    border-radius: 9px;
    font-size: 14px; font-weight: 500;
    border: none; cursor: pointer;
    transition: background 0.15s;
  }
  .rhp-btn-primary:hover { background: var(--rhw-accent); }
  .rhp-btn-ghost {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 11px 18px;
    background: var(--rhw-surface);
    color: var(--rhw-ink) !important;
    border: 1px solid var(--rhw-line);
    border-radius: 9px;
    font-size: 14px; font-weight: 500;
    cursor: pointer;
    transition: border-color 0.15s;
  }
  .rhp-btn-ghost:hover { border-color: var(--rhw-ink); }

  .rhpd-shell {
    display: grid; grid-template-columns: 260px 1fr 220px;
    max-width: 1320px; margin: 0 auto;
    padding: 32px 32px 64px;
    gap: 40px;
    align-items: start;
  }
  .rhpd-side { position: sticky; top: 78px; max-height: calc(100vh - 88px); overflow-y: auto; }
  .rhpd-side-search {
    display: flex; align-items: center; gap: 8px;
    padding: 9px 12px;
    background: var(--rhw-surface);
    border: 1px solid var(--rhw-line);
    border-radius: 9px;
    margin-bottom: 22px;
  }
  .rhpd-side-search input {
    flex: 1; min-width: 0;
    border: 0; outline: none; background: transparent;
    font: inherit; font-size: 13px;
    color: var(--rhw-ink);
  }
  .rhpd-side-search > span:first-child { color: var(--rhw-ink-mute); }
  .rhpd-side-clear {
    background: var(--rhw-bg-2);
    border: 0;
    border-radius: 4px;
    width: 18px; height: 18px;
    line-height: 16px;
    text-align: center;
    color: var(--rhw-ink-mute);
    cursor: pointer;
    font-size: 14px;
  }
  .rhpd-side-clear:hover { color: var(--rhw-ink); }

  .rhpd-side-nav { display: flex; flex-direction: column; gap: 22px; padding-bottom: 32px; }
  .rhpd-side-sec { display: flex; flex-direction: column; gap: 2px; }
  .rhpd-side-h {
    font-size: 11px; letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--rhw-ink-mute);
    margin-bottom: 6px;
    padding: 0 8px;
  }
  .rhpd-side-i {
    padding: 6px 10px;
    border-radius: 6px;
    font-size: 13px;
    color: var(--rhw-ink-soft);
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
    line-height: 1.45;
  }
  .rhpd-side-i:hover { background: var(--rhw-bg-2); color: var(--rhw-ink); }
  .rhpd-side-on { background: var(--rhw-ink); color: #fff !important; }

  .rhpd-main { min-width: 0; }
  .rhpd-crumbs {
    font-size: 11.5px;
    color: var(--rhw-ink-mute);
    display: flex; gap: 8px;
    margin-bottom: 12px;
    letter-spacing: 0.04em;
    flex-wrap: wrap;
  }
  .rhpd-crumbs a { color: var(--rhw-ink-mute); }
  .rhpd-crumbs a:hover { color: var(--rhw-ink); }
  .rhpd-cur { color: var(--rhw-ink); }

  .rhpd-h1 { font-size: 44px; letter-spacing: -0.028em; font-weight: 600; margin: 0 0 14px; }
  .rhpd-h2 { font-size: 20px; font-weight: 600; letter-spacing: -0.02em; margin: 56px 0 18px; scroll-margin-top: 90px; }
  .rhpd-lede { font-size: 17px; line-height: 1.6; color: var(--rhw-ink-soft); margin: 0 0 26px; max-width: 720px; }
  .rhpd-actions { display: inline-flex; gap: 10px; flex-wrap: wrap; margin-top: 6px; }

  .rhpd-sec { margin-bottom: 0; }
  .rhpd-p { font-size: 15px; line-height: 1.65; color: var(--rhw-ink); margin: 0 0 14px; max-width: 720px; }
  .rhpd-em { color: var(--rhw-ink); font-weight: 600; }
  .rhpd-ul, .rhpd-ol { font-size: 15px; line-height: 1.65; padding-left: 20px; margin: 0 0 14px; max-width: 720px; }
  .rhpd-ul li, .rhpd-ol li { margin-bottom: 7px; color: var(--rhw-ink); }
  .rhpd-ul li::marker { color: var(--rhw-ink-mute); }

  .rhpd-steps {
    list-style: none;
    counter-reset: rhpd-step;
    padding: 0;
    margin: 0 0 18px;
    max-width: 720px;
  }
  .rhpd-steps > li {
    counter-increment: rhpd-step;
    position: relative;
    padding-left: 36px;
    margin-bottom: 10px;
    font-size: 15px;
    line-height: 1.6;
    color: var(--rhw-ink);
  }
  .rhpd-steps > li::before {
    content: counter(rhpd-step);
    position: absolute;
    left: 0; top: 1px;
    width: 22px; height: 22px;
    border-radius: 50%;
    background: var(--rhw-ink);
    color: #fff;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    letter-spacing: 0;
  }

  .rhpd-link { color: var(--rhw-accent); border-bottom: 1px solid color-mix(in oklab, var(--rhw-accent) 35%, transparent); }
  .rhpd-link:hover { border-bottom-color: var(--rhw-accent); }

  .rhpd-kbd {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11.5px;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--rhw-bg-2);
    border: 1px solid var(--rhw-line);
    color: var(--rhw-ink);
    box-shadow: inset 0 -1px 0 var(--rhw-line);
  }

  .rhpd-pill {
    display: inline-block;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    padding: 2px 8px;
    border-radius: 999px;
    margin: 0 1px;
  }
  .rhpd-pill-pending  { background: var(--rhw-bg-2); color: var(--rhw-ink-soft); }
  .rhpd-pill-progress { background: oklch(0.88 0.12 90 / 0.30); color: oklch(0.42 0.12 80); }
  .rhpd-pill-review   { background: oklch(0.85 0.14 30 / 0.25); color: oklch(0.45 0.16 30); }
  .rhpd-pill-done     { background: oklch(0.85 0.18 145 / 0.22); color: oklch(0.42 0.13 152); }
  .rhpd-pill-deployed { background: oklch(0.52 0.20 277 / 0.16); color: var(--rhw-accent); }
  .rhpd-pill-cancelled { background: var(--rhw-bg-2); color: var(--rhw-ink-mute); text-decoration: line-through; }

  .rhpd-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 6px; }
  .rhpd-card {
    display: flex; flex-direction: column; gap: 8px;
    padding: 18px 18px 16px;
    background: var(--rhw-surface);
    border: 1px solid var(--rhw-line);
    border-radius: 12px;
    transition: border-color 0.15s, transform 0.15s;
  }
  .rhpd-card:hover { border-color: var(--rhw-ink); transform: translateY(-2px); }
  .rhpd-card-icon { font-size: 22px; }
  .rhpd-card-tag {
    font-size: 10.5px; letter-spacing: 0.06em;
    color: var(--rhw-ink-mute);
    text-transform: uppercase;
  }
  .rhpd-card-t { font-size: 15px; font-weight: 600; }
  .rhpd-card-d { font-size: 13px; color: var(--rhw-ink-soft); line-height: 1.5; flex: 1; }
  .rhpd-card-link { font-size: 12.5px; color: var(--rhw-accent); margin-top: 8px; font-weight: 500; }

  .rhpd-code-card {
    background: #0d1117;
    border-radius: 12px;
    padding: 14px 16px 16px;
    margin: 0 0 18px;
    overflow: hidden;
    max-width: 720px;
  }
  .rhpd-code-h {
    font-size: 12px; color: #b6bcc7;
    padding-bottom: 8px;
    border-bottom: 1px solid #252b36;
    margin-bottom: 8px;
    letter-spacing: 0.01em;
  }
  .rhpd-code {
    margin: 0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px; line-height: 1.7;
    color: #e6e9ef;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .rhpd-note {
    display: flex; gap: 12px;
    padding: 12px 14px;
    border: 1px solid var(--rhw-line);
    border-left-width: 3px;
    border-radius: 8px;
    background: var(--rhw-surface);
    margin: 0 0 18px;
    font-size: 14px;
    line-height: 1.55;
    max-width: 720px;
  }
  .rhpd-note-tip { border-left-color: var(--rhw-accent); }
  .rhpd-note-warn {
    border-left-color: oklch(0.62 0.18 50);
    background: oklch(0.95 0.04 60 / 0.4);
  }
  .rhpd-note-mark {
    flex: 0 0 auto;
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--rhw-ink-mute);
    padding-top: 1px;
  }

  .rhpd-changelog {
    list-style: none; padding: 0; margin: 0;
    background: var(--rhw-surface);
    border: 1px solid var(--rhw-line);
    border-radius: 12px;
    overflow: hidden;
  }
  .rhpd-changelog li {
    display: grid;
    grid-template-columns: 100px 1fr 60px;
    gap: 14px;
    padding: 12px 16px;
    align-items: center;
    border-bottom: 1px solid var(--rhw-line-soft);
    font-size: 13.5px;
  }
  .rhpd-changelog li:last-child { border-bottom: none; }
  .rhpd-cl-date { font-size: 11.5px; color: var(--rhw-ink-mute); }
  .rhpd-cl-t { color: var(--rhw-ink); }
  .rhpd-cl-kind {
    font-size: 10.5px; padding: 3px 8px;
    border-radius: 999px;
    text-align: center;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-weight: 600;
  }
  .rhpd-cl-feature { background: oklch(0.85 0.18 145 / 0.18); color: oklch(0.42 0.13 152); }
  .rhpd-cl-release { background: oklch(0.52 0.20 277 / 0.12); color: var(--rhw-accent); }

  .rhpd-prevnext {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin: 56px 0 12px;
  }
  .rhpd-pn {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 16px 18px;
    background: var(--rhw-surface);
    border: 1px solid var(--rhw-line);
    border-radius: 12px;
    transition: border-color 0.15s, transform 0.15s;
  }
  .rhpd-pn:hover { border-color: var(--rhw-ink); transform: translateY(-1px); }
  .rhpd-pn-prev { justify-content: flex-start; }
  .rhpd-pn-next { justify-content: flex-end; text-align: right; }
  .rhpd-pn-arrow { font-size: 20px; color: var(--rhw-ink-mute); }
  .rhpd-pn-kicker {
    display: block;
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--rhw-ink-mute);
    margin-bottom: 2px;
  }
  .rhpd-pn-title { font-size: 14px; font-weight: 600; color: var(--rhw-ink); }

  .rhpd-help {
    margin-top: 36px;
    background: var(--rhw-ink);
    color: #fff;
    border-radius: 14px;
    padding: 28px 32px;
    display: flex; gap: 20px;
    align-items: center; justify-content: space-between;
    flex-wrap: wrap;
  }
  .rhpd-help-h { font-size: 18px; font-weight: 600; }
  .rhpd-help-p { color: rgba(255,255,255,0.65); margin: 4px 0 0; font-size: 13.5px; }
  .rhpd-help-r { display: inline-flex; gap: 10px; flex-wrap: wrap; }
  .rhpd-help .rhp-btn-ghost { background: transparent; color: #fff !important; border-color: rgba(255,255,255,0.2); }
  .rhpd-help .rhp-btn-ghost:hover { border-color: #fff; }
  .rhpd-help .rhp-btn-primary { background: #fff; color: var(--rhw-ink) !important; }
  .rhpd-help .rhp-btn-primary:hover { background: oklch(0.85 0.18 145); }

  .rhpd-toc { position: sticky; top: 78px; max-height: calc(100vh - 88px); overflow-y: auto; }
  .rhpd-toc-h {
    font-size: 11px; letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--rhw-ink-mute);
    margin-bottom: 12px;
  }
  .rhpd-toc-i {
    display: block;
    font-size: 12.5px;
    color: var(--rhw-ink-soft);
    padding: 5px 10px;
    border-left: 2px solid var(--rhw-line);
    cursor: pointer;
    line-height: 1.4;
    transition: color 0.15s, border-color 0.15s;
  }
  .rhpd-toc-i:hover { color: var(--rhw-ink); }
  .rhpd-toc-on { color: var(--rhw-ink); border-left-color: var(--rhw-ink); font-weight: 500; }
  .rhpd-toc-meta { font-size: 11px; color: var(--rhw-ink-faint); margin-top: 18px; padding-left: 12px; }

  @media (max-width: 1100px) {
    .rhpd-shell { grid-template-columns: 240px 1fr; }
    .rhpd-toc { display: none; }
  }
  @media (max-width: 800px) {
    .rhpd-shell { grid-template-columns: 1fr; padding: 24px 20px 48px; gap: 24px; }
    .rhpd-side { position: static; max-height: none; }
    .rhpd-cards { grid-template-columns: 1fr; }
    .rhpd-h1 { font-size: 34px; }
    .rhpd-changelog li { grid-template-columns: 80px 1fr; row-gap: 4px; }
    .rhpd-cl-kind { display: none; }
    .rhpd-prevnext { grid-template-columns: 1fr; }
  }
`;
