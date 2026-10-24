import type { DocPage } from '../types';
import { Callout, Cards, Em, Kbd, NL, P, Shot, Steps, UI, UL } from '../ui';

export const GET_STARTED: DocPage[] = [
  {
    path: '/docs',
    group: 'Get started',
    title: 'RunHQ docs',
    lede: 'RunHQ is one workspace where AI agents build your product, ship it, and keep it running. These guides walk through every part of it with screenshots of the real app.',
    keywords: ['welcome', 'home', 'overview', 'introduction'],
    hero: (
      <>
        <Shot
          name="overview"
          alt="The Overview of a project in RunHQ: revenue, users, open tasks, active jobs and recent activity"
          caption="A project's Overview: what needs you, what agents are working on, and what shipped."
        />
        <Cards
          items={[
            { to: '/docs/get-started/sign-up', tag: 'Start here', title: 'Create your account', body: 'Sign up, get your free server, and sign your coding agent in.' },
            { to: '/docs/get-started/first-project', tag: 'Start here', title: 'Create a project', body: 'Describe an idea, start blank, or bring a GitHub repo.' },
            { to: '/docs/get-started/first-job', tag: 'Start here', title: 'Run your first job', body: 'Hand a task to Claude Code or Codex and watch it work.' },
            { to: '/docs/build/tasks', tag: 'Build', title: 'Tasks and the Todo board', body: 'Write work down once. Anyone can file it, any agent can pick it up.' },
            { to: '/docs/ship/review-and-merge', tag: 'Ship', title: 'Review and merge', body: 'Audited pull requests, a live preview of every branch, one shortcut to merge.' },
            { to: '/docs/support/widget', tag: 'Support', title: 'Install the widget', body: 'One script tag for analytics, a feedback board and support chat.' },
          ]}
        />
      </>
    ),
    sections: [
      {
        id: 'how-it-fits',
        heading: 'How RunHQ fits together',
        body: (
          <>
            <UL>
              <li><Em>Server.</Em> Your workspace: a machine in the RunHQ cloud where your code lives and your agents run. You get one free.</li>
              <li><Em>Project.</Em> One product or repository on that server. Each project has a strip of <Em>tools</Em> along the top: Overview, Jobs, Preview, Todo, Git, Deploy and more.</li>
              <li><Em>Task.</Em> A unit of work: a feature, a bug, a question. You write them, your users file them through the widget, and failed deploys can file them for you.</li>
              <li><Em>Job.</Em> An agent working on something. Each job is a live session with a coder (Claude Code or Codex), a terminal, and its own branch when GitHub is connected.</li>
              <li><Em>Agent.</Em> A named worker with instructions, tools and a coder. New servers come with a Claude Code agent and a Codex agent.</li>
            </UL>
            <P>The usual loop: write a task, assign it to an agent, try the result in Preview, review the pull request, merge, and deploy. After launch the widget, the support inbox and error tracking feed new tasks back into the same loop.</P>
          </>
        ),
      },
    ],
  },

  {
    path: '/docs/get-started/sign-up',
    group: 'Get started',
    title: 'Create your account',
    lede: 'Sign up, get your free server, and connect the coding agent that will do the work.',
    keywords: ['sign up', 'signup', 'register', 'login', 'sign in', 'free plan', 'credit card', 'claude login', 'codex login'],
    sections: [
      {
        id: 'sign-up',
        heading: 'Sign up',
        body: (
          <>
            <Steps>
              <li>Go to <a className="rhpd-link" href="https://app.runhq.io/signup">app.runhq.io/signup</a>.</li>
              <li>Pick a <UI>Username</UI> (3 to 20 letters, numbers or underscores; press <UI>Check</UI> to see if it is free), enter your <UI>Email</UI> and a <UI>Password</UI> of at least 8 characters.</li>
              <li>Press <UI>Create account</UI>, then open the verification link we email you.</li>
            </Steps>
            <Shot name="signup" alt="The RunHQ sign-up form with username, email and password" narrow />
            <P>Already have an account? Use <UI>Sign in</UI> at <a className="rhpd-link" href="https://app.runhq.io">app.runhq.io</a>. If you turned on two-factor authentication, you will be asked for a code from your authenticator app or a passkey next.</P>
          </>
        ),
      },
      {
        id: 'first-server',
        heading: 'Describe what you want to build',
        body: (
          <>
            <P>The first screen asks <Em>What would you like to build?</Em> Describe it in a sentence or two, choose which coder builds it (<UI>Claude Code</UI> or <UI>Codex</UI>), give the project a name, and press <UI>Create my workspace and start</UI> (or <Kbd>Ctrl+Enter</Kbd>).</P>
            <Shot name="welcome" alt="The welcome screen asking what you would like to build, with Claude Code and Codex options" narrow />
            <P>RunHQ then creates your server and project and starts the first job for you. Not ready to describe something? Use <UI>Create a Server</UI> to start empty, or <UI>Got an invite link? Join an existing workspace</UI> if a teammate invited you.</P>
          </>
        ),
      },
      {
        id: 'free-plan',
        heading: 'The free plan',
        body: (
          <>
            <P>Your first server is free and comes with <Em>$5 of agent credit</Em>. To start it you add a card through Stripe; the Free plan is $0 a month and nothing is charged unless you buy credit or upgrade.</P>
            <P>Starting a server takes a minute or two. You will see each step (creating the machine, configuring the network, booting) and then the app opens on your new project.</P>
            <Callout>Plans, credit and invoices live in <NL to="/docs/account/billing">Settings › Billing</NL>.</Callout>
          </>
        ),
      },
      {
        id: 'sign-in-coder',
        heading: 'Sign your coder in',
        body: (
          <>
            <P>Agents run Claude Code or Codex on your server, using your own account with Anthropic or OpenAI. The first time a job starts you will see <Em>Sign in to Claude to start</Em> (or the Codex equivalent):</P>
            <UL>
              <li><UI>Claude subscription</UI>: a Claude Pro, Max, Team or Enterprise plan. Usage comes out of the plan.</li>
              <li><UI>Anthropic Console</UI>: an API account, billed per token to your Console organization.</li>
            </UL>
            <Steps>
              <li>Choose the account type and press <UI>Sign in to Claude</UI>.</li>
              <li>Follow the link to Anthropic, sign in, and copy the code it shows you.</li>
              <li>Paste it into <UI>Paste the code</UI> and confirm. The job starts by itself.</li>
            </Steps>
            <P>You only do this once per server. Codex works the same way with your OpenAI account, or an OpenAI API key.</P>
          </>
        ),
      },
    ],
  },

  {
    path: '/docs/get-started/first-project',
    group: 'Get started',
    title: 'Create a project',
    lede: 'A project is one product or repository. Start one from an idea, from an empty folder, or from a GitHub repo.',
    keywords: ['new project', 'repository', 'import', 'blank'],
    sections: [
      {
        id: 'new-project',
        heading: 'Open New project',
        body: (
          <>
            <P>Click the server name at the top of the sidebar and choose <UI>New project</UI>. You can also use <UI>New project</UI> on the Server Dashboard.</P>
            <Shot name="new-project" alt="The New project dialog with Describe it, Blank project and From GitHub repo tabs" narrow />
            <P>Pick one of three ways in:</P>
            <UL>
              <li><UI>Describe it</UI>: say what you want and choose a coder. RunHQ creates the project and an agent builds the first version straight away.</li>
              <li><UI>Blank project</UI>: an empty folder, ready for your own tasks.</li>
              <li><UI>From GitHub repo</UI>: pick a repository you can access and RunHQ clones it. This needs GitHub connected; see <NL to="/docs/ship/github">Set up Git and GitHub</NL>.</li>
            </UL>
          </>
        ),
      },
      {
        id: 'from-github',
        heading: 'Start from a GitHub repository',
        body: (
          <>
            <Shot name="new-project-github" alt="The From GitHub repo tab asking you to connect GitHub" narrow />
            <P>Press <UI>Connect GitHub</UI>, authorize RunHQ, then choose the repository. Give the project a name and folder and press <UI>Create Project</UI>.</P>
            <Callout>Only server admins can create projects.</Callout>
          </>
        ),
      },
      {
        id: 'whats-inside',
        heading: "What's in a new project",
        body: (
          <>
            <P>Each project appears in the sidebar with shortcuts to its <UI>Workbench</UI>, <UI>Jobs</UI>, <UI>Preview</UI> and <UI>Agent Chat</UI>, and opens on its Overview. From the Overview's header you can start a <UI>New job</UI> or <UI>New task</UI>, <UI>Set up deploy</UI>, or open <UI>Settings</UI>.</P>
            <P>Next: <NL to="/docs/get-started/first-job">run your first job</NL>.</P>
          </>
        ),
      },
    ],
  },

  {
    path: '/docs/get-started/first-job',
    group: 'Get started',
    title: 'Run your first job',
    lede: 'A job is an agent working on something, live. Start one, watch it, and talk to it while it works.',
    keywords: ['job', 'agent', 'run', 'claude code', 'codex', 'session'],
    sections: [
      {
        id: 'start',
        heading: 'Start a job',
        body: (
          <>
            <P>The quickest way is <UI>New job</UI> (on the Overview, or the <UI>+</UI> at the top of the Jobs list, or <Kbd>Ctrl+Shift+J</Kbd>). Describe the change, choose the agent, and press <UI>Start Job</UI>.</P>
            <Shot name="new-job" alt="The New Job dialog with a description, an agent picker and a Start Job button" narrow />
            <P>Tick <UI>Create as todo task</UI> to track the job on the Todo board too. You can also start a job from an existing task with <NL to="/docs/build/tasks#assign">Assign Agent</NL>.</P>
          </>
        ),
      },
      {
        id: 'watch',
        heading: 'Watch it work',
        body: (
          <>
            <P>The job opens in the Jobs tool. The <UI>Formatted</UI> view shows the conversation: your instructions, the commands the agent runs, the files it writes, and what it says as it goes.</P>
            <Shot name="job-working" alt="A running job showing the commands and files the agent wrote, with Claude is working at the bottom" />
            <P>Switch to <UI>Terminal</UI> to see the coder's raw terminal, exactly as if you were running it yourself.</P>
            <Shot name="job-terminal" alt="The same job in Terminal view" />
          </>
        ),
      },
      {
        id: 'talk',
        heading: 'Talk to the agent',
        body: (
          <>
            <P>Type in <UI>Message Claude Code…</UI> at the bottom to add instructions, answer a question, or correct course. You can attach files and images, dictate with the microphone, and press <UI>Stop</UI> (or <Kbd>Esc</Kbd>) to interrupt.</P>
            <P>When an agent is stuck it shows <UI>Needs your input</UI> in the job header, in the Jobs list and on the Overview, and you get a notification if you allowed them.</P>
          </>
        ),
      },
      {
        id: 'finish',
        heading: 'When it finishes',
        body: (
          <>
            <P>The agent tests its own work and summarizes what it did and what you may want to change. Then:</P>
            <UL>
              <li>Try the result in <NL to="/docs/build/preview">Preview</NL>.</li>
              <li>With GitHub connected, review and merge the pull request it opened. See <NL to="/docs/ship/review-and-merge">Review and merge</NL>.</li>
              <li>Close the job with the <UI>×</UI> in its header, or keep messaging it to iterate.</li>
            </UL>
          </>
        ),
      },
    ],
  },

  {
    path: '/docs/get-started/find-your-way',
    group: 'Get started',
    title: 'Find your way around',
    lede: 'Servers on the left, projects in the sidebar, tools along the top. Here is what everything is.',
    keywords: ['navigation', 'layout', 'sidebar', 'tools', 'tabs', 'dashboard', 'home', 'tool library'],
    sections: [
      {
        id: 'layout',
        heading: 'The layout',
        body: (
          <>
            <Shot name="todo-list" alt="The RunHQ app: server rail on the far left, project sidebar, tool strip across the top, and the Todo tool open" />
            <UL>
              <li><Em>Server rail</Em> (far left): <UI>Home</UI>, then one icon per server you belong to, then <UI>+</UI> to add a server.</li>
              <li><Em>Sidebar</Em>: the server name (click it for the server menu), the <UI>Server Dashboard</UI>, and each project with its <UI>Workbench</UI>, <UI>Jobs</UI>, <UI>Preview</UI> and <UI>Agent Chat</UI>.</li>
              <li><Em>Top bar</Em>: the current project (click to switch), the <UI>Agent Chat</UI> button, and your account menu.</li>
              <li><Em>Tools</Em>: the project's tabs. Drag to reorder, or use <Kbd>Ctrl+Shift+←</Kbd> and <Kbd>Ctrl+Shift+→</Kbd> to move between them.</li>
            </UL>
          </>
        ),
      },
      {
        id: 'tools',
        heading: 'Project tools',
        body: (
          <>
            <UL>
              <li><UI>Overview</UI>: what needs you, what is running, what shipped.</li>
              <li><UI>Jobs</UI>: every agent session, live. <NL to="/docs/build/jobs">More</NL></li>
              <li><UI>Preview</UI>: your running app with terminals beside it. <NL to="/docs/build/preview">More</NL></li>
              <li><UI>Todo</UI>: tasks and the Kanban board. <NL to="/docs/build/tasks">More</NL></li>
              <li><UI>Git</UI>: pull requests, branches, worktrees and code. <NL to="/docs/ship/review-and-merge">More</NL></li>
              <li><UI>Files</UI>: browse and edit the project folder.</li>
              <li><UI>Users</UI>, <UI>Support</UI>, <UI>Sales</UI>: the people using your product and the conversations with them. <NL to="/docs/support/inbox">More</NL></li>
              <li><UI>Deploy</UI>: ship to your environments. <NL to="/docs/ship/deploy">More</NL></li>
              <li><UI>Errors</UI>, <UI>Analytics</UI>, <UI>Evolve</UI>: what your product throws, where users drop off, and experiments on real visitors. <NL to="/docs/support/errors-analytics">More</NL></li>
              <li><UI>Settings</UI>: everything about the project.</li>
            </UL>
            <P>Not every tool is on the strip by default. Open the <UI>Tool library</UI> (the last tab) to add or remove tools for a project.</P>
            <Shot name="tool-library" alt="The Tool library listing every tool with Enabled here and Available to add filters" />
          </>
        ),
      },
      {
        id: 'dashboards',
        heading: 'Dashboards',
        body: (
          <>
            <P>The <UI>Server Dashboard</UI> rolls up every project on a server: revenue, users, traffic, open requests, and the machine's CPU, memory and disk.</P>
            <Shot name="server-dashboard" alt="The Server Dashboard with revenue, users, traffic and machine usage" />
            <P><UI>Home</UI> (top of the server rail) shows every server you can reach: which are online, how many agents are working, and what is waiting to be merged.</P>
            <Shot name="home" alt="The Account Dashboard listing servers, working agents and items to merge" />
          </>
        ),
      },
      {
        id: 'server-menu',
        heading: 'The server menu',
        body: (
          <>
            <P>Click the server name at the top of the sidebar for <UI>New project</UI>, <UI>Server settings</UI>, <UI>Invite member</UI> and <UI>Leave server</UI>.</P>
            <Shot name="server-menu" alt="The server menu open with New project, Server settings, Invite member and Leave server" />
            <Callout>Keyboard user? See <NL to="/docs/reference/shortcuts">Keyboard shortcuts</NL>.</Callout>
          </>
        ),
      },
    ],
  },
];
