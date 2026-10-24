import type { DocPage } from '../types';
import { Callout, Em, H3, Kbd, NL, P, Shot, Status, Steps, Table, UI, UL } from '../ui';

export const BUILD: DocPage[] = [
  {
    path: '/docs/build/tasks',
    group: 'Build',
    title: 'Tasks and the Todo board',
    lede: 'Tasks are the unit of work. Write one, or let your users and your deploys write them, then hand them to an agent.',
    keywords: ['todo', 'todos', 'ticket', 'tickets', 'kanban', 'status', 'channels', 'backlog', 'assign agent'],
    sections: [
      {
        id: 'board',
        heading: 'The Todo tool',
        body: (
          <>
            <P>Open <UI>Todo</UI> in the tool strip. Tasks are grouped into <Em>task channels</Em> on the left (every project starts with one called <UI>todo</UI>; add more with <UI>Add new channel</UI>). Each task shows its votes, status, who filed it and which agent has it.</P>
            <Shot name="todo-list" alt="The Todo tool listing five tasks with their status and the agent assigned" />
            <P>Use the controls along the top to find things: search, <UI>View</UI> (a status, <UI>Not Done</UI>, <UI>All</UI>, or <UI>Kanban Board</UI>), <UI>By</UI> (anyone, or just you) and <UI>Sort</UI>.</P>
          </>
        ),
      },
      {
        id: 'create',
        heading: 'Create a task',
        body: (
          <>
            <Steps>
              <li>Press <UI>New Task</UI>.</li>
              <li>Write what you want. The title is optional; the description is what the agent reads, so say what done looks like. Attach screenshots, logs or any file with <UI>Attach File</UI>, or paste them in.</li>
              <li>Choose <UI>Public</UI> to show it on your public feedback board, or keep it <UI>Private</UI>.</li>
              <li>Press <UI>Create Todo</UI> to save it, or pick an agent and press <UI>Create &amp; Assign</UI> to start work immediately (<Kbd>Ctrl+Shift+Enter</Kbd>).</li>
            </Steps>
            <Shot name="new-task" alt="The new task panel with a title, a description, visibility and Create & Assign" />
            <P><UI>Auto-pick agent</UI> hands the task to the agent whose description fits it best. <UI>Run on an isolated branch</UI> gives the job its own branch and pull request; it needs <NL to="/docs/ship/github">GitHub connected</NL>.</P>
            <Callout>Select text anywhere in the app and press <Kbd>Ctrl+Shift+K</Kbd> to turn it into a new task.</Callout>
          </>
        ),
      },
      {
        id: 'assign',
        heading: 'Assign an agent',
        body: (
          <>
            <P>Open a task and press <UI>Assign Agent</UI>. Choose the agent, optionally a <UI>Command</UI> such as <UI>Proceed with implementation</UI> or <UI>Test and reproduce the issue</UI>, and press <UI>Assign</UI>. A job starts and the task moves to <Status kind="progress">In Progress</Status>.</P>
            <Shot name="assign-agent" alt="The Assign Agent dialog with an agent picker and a command" narrow />
          </>
        ),
      },
      {
        id: 'detail',
        heading: 'Inside a task',
        body: (
          <>
            <P>Click any task to open it. From here you can change its visibility and status, upvote it, assign an agent, comment (paste or drop images straight in), and follow its activity: who created it, which jobs ran, which pull request and deploy it shipped in.</P>
            <Shot name="todo-detail" alt="A task opened, with its status, Assign Agent, the activity log and a comment box" />
            <P>The <UI>⋯</UI> menu has the rest: copy a link or the task ID, mark it shipped, publish it as an update, pin it, turn off comments, reject it (with a reason that is posted as a comment), archive or delete it.</P>
          </>
        ),
      },
      {
        id: 'statuses',
        heading: 'Statuses',
        body: (
          <>
            <P>A task moves through these statuses. Most moves happen on their own as agents work and pull requests merge; you can always set one by hand.</P>
            <Table
              head={['Status', 'Means']}
              rows={[
                [<Status kind="pending">Pending</Status>, 'Filed, nobody is on it yet.'],
                [<Status kind="pending">Planned</Status>, 'Accepted and scheduled.'],
                [<Status kind="progress">In Progress</Status>, 'An agent is working on it.'],
                [<Status kind="done">Done</Status>, 'The agent finished. Waiting for you to review.'],
                [<Status kind="review">Reviewed</Status>, 'You approved the change.'],
                [<Status kind="done">Merged</Status>, 'The pull request is merged.'],
                [<Status kind="deployed">Deployed → production</Status>, 'Shipped to an environment (one status per environment).'],
                [<Status kind="cancelled">Cancelled</Status>, 'Won’t be done.'],
              ]}
            />
            <H3>Kanban</H3>
            <P>Set <UI>View</UI> to <UI>Kanban Board</UI> to see one column per status and drag tasks between them.</P>
            <Shot name="todo-kanban" alt="The Todo tool in Kanban view with Pending, Planned and In Progress columns" />
          </>
        ),
      },
    ],
  },

  {
    path: '/docs/build/jobs',
    group: 'Build',
    title: 'Jobs',
    lede: 'Every agent session, live: the conversation, the terminal, the branch and the pull request.',
    keywords: ['job', 'session', 'coder', 'switch coder', 'terminal', 'formatted', 'needs your input', 'archive'],
    sections: [
      {
        id: 'list',
        heading: 'The Jobs tool',
        body: (
          <>
            <P>Open <UI>Jobs</UI> to see every job in the project. Each row shows its state: running, needs help, queued, idle or done. Search with the magnifier, start one with <UI>+</UI>, and find finished jobs under <UI>Archived</UI>. Right-click a job to rename, pin, archive, end or delete it.</P>
            <P>Move between jobs with <Kbd>Ctrl+Shift+↑</Kbd> and <Kbd>Ctrl+Shift+↓</Kbd>.</P>
          </>
        ),
      },
      {
        id: 'start',
        heading: 'Start a job',
        body: (
          <>
            <P>There are three ways in, depending on whether the work should be tracked:</P>
            <UL>
              <li><UI>New job</UI> (<Kbd>Ctrl+Shift+J</Kbd>) for something quick. Tick <UI>Create as todo task</UI> to track it on the board too.</li>
              <li><UI>Create &amp; Assign</UI> when writing a new task.</li>
              <li><UI>Assign Agent</UI> on an existing task.</li>
            </UL>
            <Shot name="new-job" alt="The New Job dialog" narrow />
          </>
        ),
      },
      {
        id: 'view',
        heading: 'Inside a job',
        body: (
          <>
            <Shot name="job-menu" alt="A job with its header, status, the ⋯ menu open, and the conversation below" />
            <UL>
              <li><Em>Header</Em>: the job's name, its task status (click to change it), the <UI>⋯</UI> menu (<UI>View task</UI>, <UI>Switch coder</UI>, and more) and <UI>×</UI> to close the job.</li>
              <li><Em>Tabs</Em>: the coder pane plus any terminals or browsers you add with <UI>+</UI>.</li>
              <li><Em>View</Em>: <UI>Formatted</UI> renders the conversation; <UI>Terminal</UI> shows the coder's raw terminal.</li>
              <li><Em>Composer</Em>: message the agent, attach files, dictate, and see the permission mode, coder and model in use.</li>
            </UL>
          </>
        ),
      },
      {
        id: 'switch-coder',
        heading: 'Switch between Claude Code and Codex',
        body: (
          <>
            <P>Any job can change coder mid-way: open <UI>⋯</UI> and choose <UI>Switch coder to Codex</UI> (or to Claude Code), or use the coder chip in the composer. The new coder picks up in the same folder and branch. It does not see the previous coder's conversation, so tell it where things stand.</P>
          </>
        ),
      },
      {
        id: 'when-done',
        heading: 'When a job is done',
        body: (
          <>
            <P>With GitHub connected, a job that ran on an isolated branch pushes it and opens a pull request, which is audited automatically. The job header then offers the pull request, its audit, a branch preview and the merge button. See <NL to="/docs/ship/review-and-merge">Review and merge</NL>.</P>
            <P>Press <Kbd>Ctrl+Shift+D</Kbd> to close the selected job and mark its task <Status kind="done">Done</Status> in one go.</P>
          </>
        ),
      },
    ],
  },

  {
    path: '/docs/build/agents',
    group: 'Build',
    title: 'Agents',
    lede: 'Agents are the named workers on your server. Each has instructions, tools and a coder.',
    keywords: ['agent', 'claude code', 'codex', 'coder', 'auto-pick', 'system prompt', 'mcp'],
    sections: [
      {
        id: 'what',
        heading: 'What an agent is',
        body: (
          <>
            <P>An agent is a reusable worker: a name, a description of what it is good at, instructions, the tools it may use, and the coder it runs (Claude Code or Codex). Every server starts with <UI>claude coder</UI> and <UI>codex coder</UI>.</P>
            <P>Find them in <UI>Server settings › Agents</UI>, where <UI>Add Agent</UI> creates a new one.</P>
            <Shot name="server-agents" alt="Server settings, Agents section, listing claude coder, codex coder and a third agent" />
          </>
        ),
      },
      {
        id: 'choosing',
        heading: 'Claude Code or Codex',
        body: (
          <>
            <P>Both are full coding agents and both work well. Teams usually pick the one their account and habits favour, and switch per job when one gets stuck. Each needs to be signed in once per server (see <NL to="/docs/get-started/sign-up#sign-in-coder">Sign your coder in</NL>).</P>
          </>
        ),
      },
      {
        id: 'auto-pick',
        heading: 'Auto-pick',
        body: (
          <P>When you assign with <UI>Auto-pick agent</UI>, RunHQ reads each agent's description and gives the task to the one that fits. Write clear descriptions ("frontend and CSS", "billing and Stripe") and auto-pick gets better.</P>
        ),
      },
      {
        id: 'configure',
        heading: 'Configure an agent',
        body: (
          <>
            <P>Open an agent to edit its profile, its instructions (the prompt it starts every job with), the tools and MCP servers it can use, what it is allowed to do, and whether it starts on its own when something is assigned to it. Server-wide defaults live in <UI>Server settings › Agent Defaults</UI>.</P>
            <Callout kind="warn">An agent can do anything its tools and permissions allow on your server. Give each one only what its job needs.</Callout>
          </>
        ),
      },
    ],
  },

  {
    path: '/docs/build/preview',
    group: 'Build',
    title: 'Preview',
    lede: 'See your app running inside RunHQ, with a shell beside it. Every branch can get its own preview too.',
    keywords: ['preview', 'browser', 'dev server', 'start command', 'pr preview', 'port'],
    sections: [
      {
        id: 'tool',
        heading: 'The Preview tool',
        body: (
          <>
            <P>Open <UI>Preview</UI> to see your app in a browser pane, next to the terminals that run it. Each tab is a browser or a terminal; <UI>Restart</UI> restarts them all.</P>
            <Shot name="preview" alt="The Preview tool showing the Acme landing page running at localhost:3000" />
            <P>The address bar takes a URL or a port. Use the buttons on the right to open the preview in a new tab or copy a link to share with teammates.</P>
          </>
        ),
      },
      {
        id: 'set-up',
        heading: 'Set up the start command',
        body: (
          <>
            <P>Tell RunHQ how to run your app once, in <UI>Settings › Preview</UI>:</P>
            <Steps>
              <li>Press <UI>Add command</UI> → <UI>Add terminal</UI>, name it, and enter the commands that start your app (for example <code>npm run dev</code>).</li>
              <li>Press <UI>Add command</UI> → <UI>Add browser</UI> and enter the URL it serves, such as <code>http://localhost:3000</code>.</li>
              <li>Press <UI>Save Changes</UI>.</li>
            </Steps>
            <Shot name="settings-preview-command" alt="Settings, Preview section, with a Web server terminal command being added" />
            <P><UI>Auto-detect</UI> reads your project and fills these in for you. Put databases and queues under <UI>Services</UI> so previews never stop them, and list files git ignores (like <code>.env</code>) under <UI>Files to copy into previews</UI>.</P>
          </>
        ),
      },
      {
        id: 'branch-previews',
        heading: 'Preview a branch',
        body: (
          <>
            <P>With GitHub connected, every job's branch can be previewed before it merges: press <UI>Open preview</UI> on the job, the task or the pull request. Configure how branch previews start under <UI>Settings › Preview › PR Preview</UI>.</P>
            <P>Turn on <UI>Single preview slot</UI> to run one preview at a time on a fixed URL. Previewing a branch then replaces what is running, and the main checkout comes back when it ends.</P>
          </>
        ),
      },
    ],
  },

  {
    path: '/docs/build/agent-chat',
    group: 'Build',
    title: 'Agent Chat and schedules',
    lede: 'Ask an agent about your project in plain language, and have it do things on a schedule.',
    keywords: ['chat', 'assistant', 'agent chat', 'schedule', 'automation', 'cron', 'trigger', 'workflows'],
    sections: [
      {
        id: 'chat',
        heading: 'Chat with an agent',
        body: (
          <>
            <P>Press <UI>Agent Chat</UI> in the top bar (<Kbd>Ctrl+Shift+L</Kbd>) to open a chat panel beside whatever you are looking at. The agent can see the tool you have open, so you can ask "which of these tasks should we do first?" or "why did this deploy fail?". Each project also has its own <UI>Agent Chat</UI> in the sidebar.</P>
            <P>Every conversation is kept as a chat you can come back to, pin, share or delete from its <UI>⋯</UI> menu.</P>
          </>
        ),
      },
      {
        id: 'schedules',
        heading: 'Schedules',
        body: (
          <>
            <P>A chat can run on a timer. Open the chat's <UI>⋯</UI> menu, choose <UI>Automations…</UI>, then <UI>Add a schedule</UI>:</P>
            <Steps>
              <li>Pick how often it repeats, the time and the timezone. Start and end dates are optional.</li>
              <li>Under <UI>Tell the agent</UI>, write what it should do each time, for example "Post a summary of what shipped yesterday."</li>
              <li>Press <UI>Save schedule</UI>.</li>
            </Steps>
            <Shot name="automations-schedule" alt="The Add a schedule form with repeat, time, timezone and what to tell the agent" narrow />
            <P>You can also simply ask the agent to watch something ("tell me when the deploy finishes"); what it is waiting for shows in the same panel.</P>
          </>
        ),
      },
    ],
  },
];
