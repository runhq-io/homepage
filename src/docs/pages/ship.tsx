import type { DocPage } from '../types';
import { Callout, Code, Em, Kbd, NL, P, Shot, Status, Steps, Table, UI, UL } from '../ui';

export const SHIP: DocPage[] = [
  {
    path: '/docs/ship/github',
    group: 'Ship',
    title: 'Set up Git and GitHub',
    lede: 'Link a GitHub repository so agents work on their own branches and open pull requests for you to review.',
    keywords: ['git', 'github', 'repository', 'repo', 'branch', 'worktree', 'pull request', 'connect'],
    sections: [
      {
        id: 'why',
        heading: 'What GitHub adds',
        body: (
          <>
            <P>Without GitHub, agents edit the project folder directly. That is fine for a quick prototype. Once a repository is linked, each job can run on an <Em>isolated branch</Em> in its own worktree, so several agents can work at once without touching each other, and every change arrives as an audited pull request you can preview, review and merge.</P>
          </>
        ),
      },
      {
        id: 'connect',
        heading: 'Connect GitHub and link a repository',
        body: (
          <>
            <Steps>
              <li>Open the project's <UI>Settings</UI> and choose <UI>GitHub</UI>.</li>
              <li>Press <UI>Connect GitHub</UI> and authorize RunHQ on GitHub. Install the RunHQ GitHub app on the account or organization that owns your repository when GitHub asks.</li>
              <li>Search for the repository and link it. If the project folder already has files, choose whether to keep them (they show up as changes you can review and push) or replace them with the repository's contents.</li>
              <li>Set the <UI>Base branch</UI> that pull requests target, usually <code>main</code>.</li>
            </Steps>
            <Shot name="settings-github" alt="Project settings, GitHub section, before a repository is linked" />
            <Callout>You only see repositories your GitHub account can access. If RunHQ can't push to the repository, the GitHub section says so and jobs won't open pull requests until it's fixed.</Callout>
          </>
        ),
      },
      {
        id: 'pr-settings',
        heading: 'Pull request automation',
        body: (
          <>
            <P>Once linked, the same section has switches for what happens to pull requests:</P>
            <UL>
              <li><UI>Auto-audit pull requests</UI>: an AI reviewer checks every pull request agents open.</li>
              <li><UI>Auto-start fix on audit issues</UI>: send audit findings straight back to the agent that wrote the code.</li>
              <li><UI>Auto-resolve merge conflicts</UI>: start a job to fix conflicts when the base branch moves.</li>
              <li><UI>Auto-merge pull requests</UI>: merge once a pull request is ready and its audit passes. Admins choose whose work may merge itself.</li>
              <li><UI>Auto-sync local base branch</UI>: keep the project folder's copy of the base branch up to date.</li>
            </UL>
          </>
        ),
      },
      {
        id: 'git-tool',
        heading: 'The Git tool',
        body: (
          <>
            <P>The <UI>Git</UI> tool shows the linked repository: <UI>PRs</UI> (open, merged, closed), <UI>Branches</UI>, <UI>Worktrees</UI> (one per job running on its own branch) and <UI>Code</UI>.</P>
            <Shot name="git-tool" alt="The Git tool with PRs, Branches, Worktrees and Code tabs, before GitHub is linked" />
          </>
        ),
      },
    ],
  },

  {
    path: '/docs/ship/review-and-merge',
    group: 'Ship',
    title: 'Review and merge',
    lede: 'Every change an agent makes arrives as a pull request: audited, previewable, and one shortcut away from merged.',
    keywords: ['pull request', 'pr', 'review', 'audit', 'merge', 'diff', 'conflicts', 'pr reviews'],
    sections: [
      {
        id: 'flow',
        heading: 'From job to pull request',
        body: (
          <>
            <P>When a job runs on an isolated branch (GitHub connected), the agent commits its work, pushes the branch, and RunHQ opens a pull request against your base branch. The task moves to <Status kind="done">Done</Status> and the pull request appears on the job, on the task, and in the <UI>Git</UI> tool.</P>
          </>
        ),
      },
      {
        id: 'audit',
        heading: 'The audit',
        body: (
          <>
            <P>With <UI>Auto-audit pull requests</UI> on, an AI reviewer reads every pull request. Its badge reads <UI>Auditing…</UI>, then <UI>Audit passed</UI> or <UI>Audit failed</UI>. Open <UI>View audit</UI> for the findings and press <UI>Fix issues</UI> to send them to the agent, which pushes a fix to the same branch. Choose which engine audits (Claude Code or Codex) in <UI>Server settings</UI>.</P>
          </>
        ),
      },
      {
        id: 'review',
        heading: 'Review the change',
        body: (
          <>
            <UL>
              <li><Em>Try it.</Em> Press <UI>Open preview</UI> to run the branch and click through the change instead of imagining it from a diff. See <NL to="/docs/build/preview#branch-previews">Preview a branch</NL>.</li>
              <li><Em>Read it.</Em> Open the diff from the pull request. The review editor shows every changed file, read-only, with <Kbd>Ctrl+P</Kbd> to jump to a file.</li>
              <li><Em>Ask for changes.</Em> Message the agent in the job ("the button should be on the left") and it pushes another commit.</li>
            </UL>
            <P>Across all your servers, <UI>PR reviews</UI> on <UI>Home</UI> lists every ticket that is in progress or ready to merge, with its summary, audit, session and merge button side by side.</P>
          </>
        ),
      },
      {
        id: 'merge',
        heading: 'Merge',
        body: (
          <>
            <P>Press <UI>Merge</UI> on the job, the task or the pull request, or <Kbd>Ctrl+Shift+M</Kbd> on the selected job. The arrow beside it chooses the merge method. If the pull request can't merge yet you'll see why: still a draft (<UI>Mark ready</UI>), checks pending, or conflicts (<UI>Resolve conflicts in a job</UI> starts an agent on them).</P>
            <P>After merging, the task moves to <Status kind="done">Merged</Status> and is staged for the next deploy.</P>
            <P>To turn a change down instead, close the pull request from the <UI>Git</UI> tool, or reject the task from its <UI>⋯</UI> menu.</P>
          </>
        ),
      },
    ],
  },

  {
    path: '/docs/ship/deploy',
    group: 'Ship',
    title: 'Deploy',
    lede: 'Ship to your environments from RunHQ, watch the output live, and see exactly which tasks each deploy carries.',
    keywords: ['deploy', 'release', 'environment', 'production', 'staging', 'tests', 'ship'],
    sections: [
      {
        id: 'environments',
        heading: 'Set up an environment',
        body: (
          <>
            <P>Open <UI>Settings › Deploy</UI> (or <UI>Set up deploy</UI> on the Overview) and press <UI>Add environment</UI>:</P>
            <Table
              head={['Field', 'What to enter']}
              rows={[
                [<UI>Environment name</UI>, <>For example <code>production</code> or <code>staging</code>.</>],
                [<UI>Branch</UI>, 'The branch this environment ships from, usually main.'],
                [<UI>Color</UI>, 'Tints the deploy badge on tasks shipped here.'],
                [<UI>Test command</UI>, 'Runs first. If it fails, the deploy is blocked. Leave blank to skip tests.'],
                [<UI>Deploy command</UI>, 'Runs in the project folder, one line at a time. This is whatever you already use to ship: a CLI, a script, a push to your host.'],
                [<UI>On successful deploy</UI>, <><UI>Do nothing</UI>, <UI>Promote tasks</UI> (move shipped tasks to Deployed), or <UI>Promote tasks &amp; close finished jobs</UI>.</>],
              ]}
            />
            <Shot name="settings-deploy-env" alt="Settings, Deploy section, with the environment fields" />
            <P>The deploy command can read your project's secret variables (Settings › Secret Variables) as environment variables, plus <code>$DEPLOY_ENVIRONMENT</code> and <code>$DEPLOY_BRANCH</code>. For example:</P>
            <Code title="Deploy command examples">{`# A static site on Cloudflare Pages
npm run build
npx wrangler pages deploy dist --project-name=acme

# A Fly.io app
fly deploy --remote-only`}</Code>
            <P><UI>Auto-detect</UI> proposes test and deploy commands from your project, and <UI>Find &amp; structure tests</UI> starts an agent to organise your test suite so deploys can rely on it.</P>
          </>
        ),
      },
      {
        id: 'ship',
        heading: 'Deploy',
        body: (
          <>
            <P>Open the <UI>Deploy</UI> tool, pick the environment, and press <UI>Deploy production</UI> (or whatever the environment is called). The arrow beside it offers a deploy that skips tests.</P>
            <Shot name="deploy-run" alt="The Deploy tool after a successful production deploy, with the deploy output" />
            <UL>
              <li><UI>Next deploy</UI> lists the tasks merged since the last deploy: exactly what this deploy will ship.</li>
              <li>Each run in the history has <UI>Tests</UI>, <UI>Deploy</UI> and <UI>Tickets</UI> tabs with the live output and the tasks it carried.</li>
            </UL>
          </>
        ),
      },
      {
        id: 'failures',
        heading: 'When a deploy fails',
        body: (
          <>
            <P>A failed run shows <UI>Deploy failed</UI> or <UI>Tests failed — deploy blocked</UI> with the output. Press <UI>Create ticket to fix failures</UI> and an agent gets a task with the logs attached; once it is filed the button becomes <UI>View ticket</UI>.</P>
            <Callout>Deploying needs the <Em>Manage Project</Em> permission. See <NL to="/docs/team/roles">Roles and permissions</NL>.</Callout>
          </>
        ),
      },
      {
        id: 'statuses',
        heading: 'What your users see',
        body: (
          <P>With <UI>Promote tasks</UI> on, every task in a successful deploy moves to <Status kind="deployed">Deployed → production</Status>, and the public feedback board shows it under <UI>Updates</UI>. The people who asked for it can see it shipped.</P>
        ),
      },
    ],
  },
];

