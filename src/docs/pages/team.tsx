import type { DocPage } from '../types';
import { Callout, Em, Kbd, NL, P, Shot, Steps, Table, UI, UL } from '../ui';

export const TEAM: DocPage[] = [
  {
    path: '/docs/team/invite',
    group: 'Team & account',
    title: 'Invite teammates',
    lede: 'Bring your team onto a server with a link or an email invite.',
    keywords: ['invite', 'team', 'members', 'join', 'link', 'email', 'bans'],
    sections: [
      {
        id: 'link',
        heading: 'Share an invite link',
        body: (
          <>
            <Steps>
              <li>Click the server name at the top of the sidebar and choose <UI>Invite member</UI>.</li>
              <li>On <UI>Invite Link</UI>, set when it <UI>Expires After</UI> and its <UI>Max Uses</UI>, then press <UI>Copy link</UI> (or <UI>Generate New Link</UI> for a fresh one).</li>
              <li>Send the link. Anyone who opens it signs in or creates an account and joins the server.</li>
            </Steps>
            <Shot name="invite" alt="The Invite Members dialog with an invite link, expiry, max uses and active links" narrow />
            <P>Every link you have made is listed under <UI>Active links</UI>, with how many times it was used and how long it has left. Delete one to revoke it.</P>
          </>
        ),
      },
      {
        id: 'email',
        heading: 'Invite by email',
        body: (
          <>
            <P>On the <UI>Direct Invite</UI> tab, enter an email address and press <UI>Send Invite</UI>. Change their role in Members once they have joined.</P>
            <Shot name="invite-email" alt="The Direct Invite tab with an email address field" narrow />
            <Callout>The Free plan is for one person. Upgrade to Starter or Pro to invite teammates; see <NL to="/docs/account/billing">Plans and billing</NL>.</Callout>
          </>
        ),
      },
      {
        id: 'members',
        heading: 'Manage members',
        body: (
          <>
            <P><UI>Server settings › Members</UI> lists everyone on the server with their role. Change a role, remove someone, or ban them (banned people are listed under <UI>Bans</UI>). <UI>Invite People</UI> opens the same invite dialog.</P>
            <Shot name="server-members" alt="Server settings, Members section, listing the owner" />
          </>
        ),
      },
    ],
  },

  {
    path: '/docs/team/roles',
    group: 'Team & account',
    title: 'Roles and permissions',
    lede: 'Decide what each person can see and do, server-wide and per project.',
    keywords: ['roles', 'permissions', 'admin', 'owner', 'member', 'security', '2fa', 'ip allowlist'],
    sections: [
      {
        id: 'roles',
        heading: 'Built-in roles',
        body: (
          <>
            <UL>
              <li><Em>Owner</Em>: the person who created the server. Can do everything, including billing, deleting the server and <UI>Transfer Ownership</UI>.</li>
              <li><Em>Admin</Em>: manages projects, members, agents and settings.</li>
              <li><Em>Member</Em>: works in the projects they can see, within the permissions below.</li>
            </UL>
            <P>Everyone also has the <UI>@everyone</UI> role, which sets the baseline for the whole server.</P>
          </>
        ),
      },
      {
        id: 'custom',
        heading: 'Custom roles',
        body: (
          <>
            <P>In <UI>Server settings › Roles</UI>, press <UI>+</UI> to create a role, choose its permissions, and give it to members. A person's permissions are everything their roles allow.</P>
            <Shot name="server-roles" alt="Server settings, Roles section" />
            <Table
              head={['Permission', 'Allows']}
              rows={[
                [<UI>Manage Project</UI>, 'Change project settings and deploy.'],
                [<UI>View Preview</UI>, 'Open the project’s previews.'],
                [<UI>View Tasks</UI>, 'See the Todo board.'],
                [<UI>Create Tasks</UI>, 'File new tasks.'],
                [<UI>Comment on Tasks</UI>, 'Comment on tasks.'],
                [<UI>Upvote Tasks</UI>, 'Vote on tasks.'],
                [<UI>Edit &amp; Delete Tasks</UI>, 'Change or remove anyone’s tasks.'],
                [<UI>Assign Agents</UI>, 'Hand tasks to agents (which spends agent credit).'],
              ]}
            />
          </>
        ),
      },
      {
        id: 'security',
        heading: 'Security settings',
        body: (
          <>
            <P>In <UI>Server settings › Security</UI>, turn on <UI>Require MFA for all members</UI> to make two-factor authentication mandatory. The adoption summary shows who still needs to set it up. Each person sets up their authenticator app or passkey under their own <UI>Settings › Security</UI>.</P>
            <Shot name="server-settings" alt="Server settings with its sections: General, Projects, Machine, Members, Roles, Security, Agents and more" />
          </>
        ),
      },
    ],
  },

  {
    path: '/docs/account/billing',
    group: 'Team & account',
    title: 'Plans, credit and billing',
    lede: 'What each plan includes, how agent credit works, and where to find invoices.',
    keywords: ['billing', 'plans', 'pricing', 'credit', 'invoice', 'starter', 'pro', 'free', 'usage', 'payment'],
    sections: [
      {
        id: 'plans',
        heading: 'Plans',
        body: (
          <>
            <Table
              head={['Plan', 'Price', 'Includes']}
              rows={[
                ['Free', '$0', '$5 one-time agent credit, 1 server, 1 member.'],
                ['Starter', '$100/month + $15/seat', '$75 of agent credit every month, unlimited servers and members.'],
                ['Pro', '$250/month + $25/seat', '$200 of agent credit every month, unlimited servers and members, a public feedback widget and graph-based agent flows.'],
              ]}
            />
            <P>See <NL to="/pricing">Pricing</NL> for Enterprise.</P>
          </>
        ),
      },
      {
        id: 'credit',
        heading: 'Agent credit',
        body: (
          <>
            <P>Agent credit pays for RunHQ's own AI work: the support agent, audits, auto-detection and the assistant. (The coders, Claude Code and Codex, use your own Anthropic or OpenAI account.) Your plan's credit renews monthly; credit you buy never expires.</P>
            <P>If credit runs out, agents pause until you top up, and eventually the server is suspended.</P>
          </>
        ),
      },
      {
        id: 'manage',
        heading: 'Manage billing',
        body: (
          <>
            <P>Open your account menu (your name, top right) › <UI>Settings</UI> › <UI>Billing</UI>. You can see your credit balance and spend this period, change the payment method, <UI>Buy Credits</UI>, switch plans, and download invoices. <UI>Usage</UI> breaks down where the credit went.</P>
            <Shot name="billing" alt="Billing and usage with the credit balance, payment method, buy credits and plans" />
          </>
        ),
      },
    ],
  },

  {
    path: '/docs/reference/shortcuts',
    group: 'Reference',
    title: 'Keyboard shortcuts',
    lede: 'Get around RunHQ without the mouse. On a Mac, Ctrl is still Ctrl unless noted.',
    keywords: ['keyboard', 'shortcuts', 'hotkeys', 'keys'],
    sections: [
      {
        id: 'everywhere',
        heading: 'Everywhere',
        body: (
          <Table
            head={['Shortcut', 'Action']}
            rows={[
              [<Kbd>Ctrl+Shift+J</Kbd>, 'New job'],
              [<Kbd>Ctrl+Shift+K</Kbd>, 'New task from the selected text'],
              [<Kbd>Ctrl+Shift+L</Kbd>, 'Open Agent Chat'],
              [<Kbd>Ctrl+Shift+P</Kbd>, 'Back to the previous project'],
              [<Kbd>Ctrl+Shift+←</Kbd>, 'Previous tool'],
              [<Kbd>Ctrl+Shift+→</Kbd>, 'Next tool'],
              [<Kbd>Ctrl+`</Kbd>, 'Next agent'],
              [<Kbd>Ctrl+Shift+`</Kbd>, 'Previous agent'],
            ]}
          />
        ),
      },
      {
        id: 'jobs',
        heading: 'Jobs',
        body: (
          <Table
            head={['Shortcut', 'Action']}
            rows={[
              [<Kbd>Ctrl+Shift+↑</Kbd>, 'Previous job'],
              [<Kbd>Ctrl+Shift+↓</Kbd>, 'Next job'],
              [<Kbd>Ctrl+Shift+M</Kbd>, 'Merge the job’s pull request'],
              [<Kbd>Ctrl+Shift+D</Kbd>, 'Close the job and mark its task Done'],
              [<Kbd>Ctrl+Shift+R</Kbd>, 'Run the job’s workflow'],
              [<Kbd>Esc</Kbd>, 'Stop the agent'],
              [<Kbd>Ctrl+Shift+F</Kbd>, 'Find in the terminal (⌘F on Mac)'],
            ]}
          />
        ),
      },
      {
        id: 'tasks-files',
        heading: 'Tasks and files',
        body: (
          <Table
            head={['Shortcut', 'Action']}
            rows={[
              [<Kbd>Ctrl+Shift+Enter</Kbd>, 'Create a task and assign it'],
              [<Kbd>Ctrl+Enter</Kbd>, 'Send a message or submit a form'],
              [<Kbd>Ctrl+P</Kbd>, 'Go to a file in the review editor'],
              [<Kbd>Ctrl+Alt+G</Kbd>, 'Go to a line in Files'],
              [<Kbd>Alt+↑</Kbd>, 'Move the selected sidebar row up (Alt+↓ moves it down)'],
            ]}
          />
        ),
      },
    ],
  },

  {
    path: '/docs/reference/glossary',
    group: 'Reference',
    title: 'Glossary',
    lede: 'The words RunHQ uses, in one place.',
    keywords: ['glossary', 'terms', 'definitions', 'worktree', 'server', 'workspace'],
    sections: [
      {
        id: 'terms',
        heading: 'Terms',
        body: (
          <Table
            head={['Term', 'Meaning']}
            rows={[
              ['Server', 'Your workspace: a machine where your projects live and agents run. Also called a workspace.'],
              ['Project', 'One product or repository on a server, with its own tools and settings.'],
              ['Tool', 'A tab in a project: Overview, Jobs, Preview, Todo, Git, Deploy and so on. Add more from the Tool library.'],
              ['Task', 'A unit of work on the Todo board. Called a ticket on the public board and in the widget.'],
              ['Task channel', 'A list of tasks inside a project, such as todo or bugs.'],
              ['Job', 'An agent working on something: a live session with a coder and a terminal.'],
              ['Agent', 'A named worker with instructions, tools and a coder.'],
              ['Coder', 'The coding agent a job runs: Claude Code (Anthropic) or Codex (OpenAI).'],
              ['Isolated branch', 'A branch and worktree of its own for one job, so jobs don’t collide. Needs GitHub.'],
              ['Worktree', 'A separate checkout of the repository for one branch.'],
              ['Audit', 'An AI review of a pull request, run automatically when it opens.'],
              ['Preview', 'Your app running inside RunHQ, for the main checkout or any branch.'],
              ['Environment', 'Somewhere you deploy to, such as production, with its own branch and commands.'],
              ['Widget', 'The script on your site that adds analytics, the feedback board and support chat.'],
              ['Agent credit', 'What RunHQ’s own AI features spend. Your coders use your own Anthropic or OpenAI account.'],
            ]}
          />
        ),
      },
    ],
  },
];
