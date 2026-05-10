import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Navbar, Footer, SIGNUP_URL } from '../components/chrome';

// =============================================================================
// Inline helpers — keep markup short inside the page registry below.
// =============================================================================

const P = ({ children }: { children: React.ReactNode }) => <p className="rhpd-p">{children}</p>;
const Em = ({ children }: { children: React.ReactNode }) => <span className="rhpd-em">{children}</span>;
const Kbd = ({ children }: { children: React.ReactNode }) => <span className="rhpd-kbd">{children}</span>;
const UL = ({ children }: { children: React.ReactNode }) => <ul className="rhpd-ul">{children}</ul>;
const OL = ({ children }: { children: React.ReactNode }) => <ol className="rhpd-ol">{children}</ol>;
const NL = ({ to, children }: { to: string; children: React.ReactNode }) => (
  <Link className="rhpd-link" to={to}>{children}</Link>
);

const Code = ({ title, children }: { title?: string; children: string }) => (
  <div className="rhpd-code-card">
    {title && <div className="rhpd-code-h">{title}</div>}
    <pre className="rhpd-code">{children}</pre>
  </div>
);

const Callout = ({ kind = 'tip', children }: { kind?: 'tip' | 'warn'; children: React.ReactNode }) => (
  <div className={`rhpd-note rhpd-note-${kind}`}>
    <span className="rhpd-note-mark mono">{kind === 'tip' ? 'Tip' : 'Heads up'}</span>
    <div>{children}</div>
  </div>
);

const Steps = ({ children }: { children: React.ReactNode }) => <ol className="rhpd-steps">{children}</ol>;

const Pill = ({ children, kind }: { children: React.ReactNode; kind: 'pending' | 'progress' | 'review' | 'done' | 'deployed' | 'cancelled' }) => (
  <span className={`rhpd-pill rhpd-pill-${kind}`}>{children}</span>
);

// =============================================================================
// Page registry
// =============================================================================

type Section = { id: string; heading: string; body: React.ReactNode };
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

// -------- Welcome page hero & changelog --------

const DOC_CARDS = [
  { t: 'Set up your first project',  d: 'Pick a name, an icon, and you\'re running. RunHQ creates the channels you\'ll need.', tag: 'Get started', icon: '◯', to: '/docs/first-project' },
  { t: 'File a todo',                d: 'Todos are the unit of work. Anyone on the team can file one.',                       tag: 'Get started', icon: '◢', to: '/docs/first-todo' },
  { t: 'Run an agent',               d: 'Hit Run on a todo. Watch Claude or Codex pick it up live.',                          tag: 'Get started', icon: '⚡', to: '/docs/run-agent' },
  { t: 'Review the diff',            d: 'When the agent finishes, you decide what ships.',                                    tag: 'Daily',       icon: '◇', to: '/docs/agents/reviewing' },
  { t: 'Capture feedback on your site', d: 'Drop the widget on any page. Users file todos straight into your queue.',         tag: 'Setup',       icon: '◉', to: '/docs/widget/overview' },
  { t: 'Invite your team',           d: 'Add teammates. Pick what each role can see and do.',                                 tag: 'For admins',  icon: '◈', to: '/docs/team/invites' },
];

const WHATS_NEW: { date: string; title: string; kind: 'feature' | 'release' }[] = [
  { date: '2026-05-08', title: 'Multiple agents can now work at once without their changes colliding.', kind: 'feature' },
  { date: '2026-04-30', title: 'Codex (OpenAI) is now an official agent option, alongside Claude Code.', kind: 'release' },
  { date: '2026-04-22', title: 'Smarter triaging — todos route to the agent most active in the relevant channel.', kind: 'feature' },
  { date: '2026-04-12', title: 'Sessions are now called Jobs. Same thing, clearer name.', kind: 'release' },
];

const WELCOME_HERO = (
  <>
    <div className="rhpd-actions">
      <Link className="rhp-btn-primary" to="/docs/sign-in">Get started →</Link>
      <Link className="rhp-btn-ghost" to="/docs/agents/overview">How agents work</Link>
    </div>

    <h2 className="rhpd-h2" id="pick-a-path">Where to start</h2>
    <div className="rhpd-cards">
      {DOC_CARDS.map((c) => (
        <Link key={c.t} className="rhpd-card" to={c.to}>
          <div className="rhpd-card-icon">{c.icon}</div>
          <div className="rhpd-card-tag mono">{c.tag}</div>
          <div className="rhpd-card-t">{c.t}</div>
          <div className="rhpd-card-d">{c.d}</div>
          <div className="rhpd-card-link">Read →</div>
        </Link>
      ))}
    </div>
  </>
);

const WELCOME_OUTRO = (
  <>
    <h2 className="rhpd-h2" id="whats-new">What's new</h2>
    <ul className="rhpd-changelog">
      {WHATS_NEW.map((c) => (
        <li key={c.title}>
          <span className="rhpd-cl-date mono">{c.date}</span>
          <span className="rhpd-cl-t">{c.title}</span>
          <span className={`rhpd-cl-kind rhpd-cl-${c.kind}`}>{c.kind === 'feature' ? 'New' : 'Update'}</span>
        </li>
      ))}
    </ul>
  </>
);

// =============================================================================
// PAGES
// =============================================================================

const PAGES: DocPage[] = [
  // ============================================================ Get started
  {
    path: '/docs',
    group: 'Get started',
    title: 'Welcome to RunHQ',
    lede: (
      <>RunHQ is where your team's AI coding agents do their work. File a todo from anywhere — a meeting, a Slack thread, an email, the widget on your site — and an agent picks it up, writes the change, and hands the diff back for review. One workspace. One inbox. Everything on the record.</>
    ),
    hero: WELCOME_HERO,
    sections: [],
    outro: WELCOME_OUTRO,
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
        heading: 'What you\'ll see',
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
        heading: 'What\'s automatic',
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
// Layout
// =============================================================================

const PATH_INDEX: Record<string, number> = Object.fromEntries(PAGES.map((p, i) => [p.path, i]));

function buildSidebar() {
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
  for (const p of PAGES) groups[p.group].push(p);
  return groups;
}

function PrevNext({ idx }: { idx: number }) {
  const prev = idx > 0 ? PAGES[idx - 1] : null;
  const next = idx < PAGES.length - 1 ? PAGES[idx + 1] : null;
  if (!prev && !next) return null;
  return (
    <nav className="rhpd-prevnext">
      {prev ? (
        <Link to={prev.path} className="rhpd-pn rhpd-pn-prev">
          <span className="rhpd-pn-arrow">←</span>
          <span>
            <span className="rhpd-pn-kicker mono">Previous</span>
            <span className="rhpd-pn-title">{prev.title}</span>
          </span>
        </Link>
      ) : <span />}
      {next ? (
        <Link to={next.path} className="rhpd-pn rhpd-pn-next">
          <span>
            <span className="rhpd-pn-kicker mono">Next</span>
            <span className="rhpd-pn-title">{next.title}</span>
          </span>
          <span className="rhpd-pn-arrow">→</span>
        </Link>
      ) : <span />}
    </nav>
  );
}

function HelpBlock() {
  return (
    <div className="rhpd-help">
      <div>
        <div className="rhpd-help-h">Need a hand?</div>
        <p className="rhpd-help-p">Solutions team responds in &lt;4 hours, weekdays. Enterprise is 24/7.</p>
      </div>
      <div className="rhpd-help-r">
        <a className="rhp-btn-ghost" href={SIGNUP_URL}>Open chat</a>
        <a className="rhp-btn-primary" href="mailto:admin@runhq.io">Email support →</a>
      </div>
    </div>
  );
}

function SearchBar({ query, setQuery }: { query: string; setQuery: (q: string) => void }) {
  return (
    <div className="rhpd-side-search">
      <span>⌕</span>
      <input
        placeholder="Filter docs…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {query && <button className="rhpd-side-clear" onClick={() => setQuery('')} aria-label="Clear">×</button>}
    </div>
  );
}

function Sidebar({ currentPath, query, setQuery }: { currentPath: string; query: string; setQuery: (q: string) => void }) {
  const groups = useMemo(buildSidebar, []);
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
              <div className="rhpd-side-h">{g}</div>
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
  const items = page.sections.map((s) => ({ id: s.id, label: s.heading }));
  if (items.length === 0) return null;
  return (
    <aside className="rhpd-toc">
      <div className="rhpd-toc-h mono">On this page</div>
      {items.map((i) => (
        <a
          key={i.id}
          href={`#${i.id}`}
          className={`rhpd-toc-i ${activeId === i.id ? 'rhpd-toc-on' : ''}`}
        >
          {i.label}
        </a>
      ))}
      <div className="rhpd-toc-meta mono">v2.2 · last updated May 10</div>
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
  const path = loc.pathname.replace(/\/+$/, '') || '/docs';
  const idx = PATH_INDEX[path];
  const page = idx !== undefined ? PAGES[idx] : null;

  const [query, setQuery] = useState('');
  const sectionIds = page?.sections.map((s) => s.id) ?? [];
  const activeId = useActiveSection(sectionIds);

  return (
    <div className="rhp-root rhpd-root">
      <style>{DOCS_STYLES}</style>
      <Navbar active="docs" />

      <div className="rhpd-shell">
        <Sidebar currentPath={path} query={query} setQuery={setQuery} />

        <main className="rhpd-main">
          {page ? (
            <>
              <div className="rhpd-crumbs mono">
                <Link to="/docs">Docs</Link>
                <span>/</span>
                <span>{page.group}</span>
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

              <PrevNext idx={idx!} />
              <HelpBlock />
            </>
          ) : (
            <div className="rhpd-404">
              <div className="rhpd-crumbs mono">
                <Link to="/docs">Docs</Link>
                <span>/</span>
                <span className="rhpd-cur">Not found</span>
              </div>
              <h1 className="rhpd-h1">That page doesn't exist.</h1>
              <p className="rhpd-lede">Try the <Link className="rhpd-link" to="/docs">welcome page</Link> or use the search above.</p>
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
