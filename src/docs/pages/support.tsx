import type { DocPage } from '../types';
import { Callout, Code, H3, NL, P, Shot, Steps, Table, UI, UL } from '../ui';

export const SUPPORT: DocPage[] = [
  {
    path: '/docs/support/widget',
    group: 'Support & sales',
    title: 'Install the widget and SDK',
    lede: 'One script tag on your site gives you analytics, error tracking, a public feedback board and support chat.',
    keywords: ['widget', 'sdk', 'script', 'install', 'feedback board', 'board', 'identify', 'tracking', 'embed'],
    sections: [
      {
        id: 'enable',
        heading: 'Turn on the SDK',
        body: (
          <>
            <P>Open the project's <UI>Settings › SDK</UI> and press <UI>Enable SDK</UI>. You get one script that tracks page views, sign-ups, revenue and errors (choose what with the <UI>Tracking</UI> and <UI>Interaction capture</UI> switches) and powers everything else on this page.</P>
            <Shot name="settings-sdk-install" alt="Settings, SDK section, with the script tag to paste and the identify snippet" />
          </>
        ),
      },
      {
        id: 'add-script',
        heading: 'Add the script to your site',
        body: (
          <>
            <Steps>
              <li>Pick your platform (plain HTML, Next.js, React/Vite, Nuxt, SvelteKit, Rails, Django, Laravel, WordPress) to see where the tag goes, then press <UI>Copy</UI>.</li>
              <li>Paste it into the <code>&lt;head&gt;</code> of every page, usually your shared layout.</li>
              <li>Load your site and check that your visit shows up in RunHQ.</li>
            </Steps>
            <Code title="index.html">{`<script src="https://console.runhq.io/widget.js"
        data-project="your-project-slug"
        data-environment="auto"></script>`}</Code>
            <P><code>data-environment="auto"</code> keeps local and preview traffic out of your production numbers. Add <code>data-track-only="true"</code> if you want analytics without the widget.</P>
            <Callout>Rather not touch the code yourself? Press <UI>Create a task to install the SDK</UI> and an agent does it.</Callout>
          </>
        ),
      },
      {
        id: 'identify',
        heading: 'Identify signed-in users',
        body: (
          <>
            <P>Tell RunHQ who is signed in, so feedback, conversations and errors are tied to real people:</P>
            <Code>{`RunHQWidget.identify(user.id, { email: user.email, name: user.name });`}</Code>
            <P>The same object also has <code>.track</code>, <code>.stage</code>, <code>.revenue</code> and <code>.variation</code> for custom events, funnel stages, revenue and experiments. To stop users from impersonating each other, sign their identity on your server; the SDK section shows how for Node.js, PHP, Python and Ruby.</P>
          </>
        ),
      },
      {
        id: 'board',
        heading: 'Turn on the feedback board',
        body: (
          <>
            <P>Open <UI>Settings › Feedback Widget</UI> and choose a <UI>Target todo list</UI>: the task channel new tickets go into. The board turns on (<UI>Board on</UI>).</P>
            <Shot name="settings-widget" alt="Settings, Feedback Widget section, with the target todo list, slug, position and language" />
            <Table
              head={['Setting', 'What it does']}
              rows={[
                [<UI>Project Slug</UI>, <>The address of your public board: <code>www.runhq.io/your-slug</code>.</>],
                [<UI>Widget Position</UI>, 'Where the launcher sits on your pages.'],
                [<UI>Widget Language</UI>, 'English or Korean.'],
                [<UI>Make project public</UI>, 'Anyone can read the board. To let anonymous visitors vote or post, set a Login URL so they can sign in first.'],
                [<UI>Auto-recognize RunHQ workspace members</UI>, 'Your team is signed in to the widget automatically on your registered domains (Allowed origins).'],
                [<UI>Voting Period</UI>, 'How long new tickets can be voted on.'],
              ]}
            />
            <P>The <UI>Permissions</UI> and <UI>Star Rewards</UI> tabs control who can file, vote and comment, and the stars people earn for feedback that ships.</P>
          </>
        ),
      },
      {
        id: 'users-see',
        heading: 'What your users see',
        body: (
          <>
            <P>A tab appears on the edge of your site:</P>
            <Shot name="widget-launcher" alt="The Acme landing page with the RunHQ widget tab on its right edge" />
            <P>Clicking it opens the widget:</P>
            <Shot name="widget-open" alt="The widget open on the Acme site, with Home, Tickets, Updates and My Tickets tabs and a New Ticket button" />
            <UL>
              <li><UI>Home</UI>: trending tickets, recent updates and activity.</li>
              <li><UI>Tickets</UI>: the public board, where people vote and comment.</li>
              <li><UI>Updates</UI>: what you shipped, filled in automatically by your deploys.</li>
              <li><UI>My Tickets</UI>: what this person filed and where it stands.</li>
              <li><UI>New Ticket</UI>: file feedback or a bug. It lands as a task in your target list.</li>
            </UL>
            <P>The same board is also a page of its own at <code>www.runhq.io/your-slug</code>, handy for linking from emails.</P>
          </>
        ),
      },
    ],
  },

  {
    path: '/docs/support/inbox',
    group: 'Support & sales',
    title: 'Support inbox and support agent',
    lede: 'Every conversation with your users in one place, with an agent that answers and files tickets for you.',
    keywords: ['support', 'inbox', 'chat', 'conversation', 'email', 'sms', 'whatsapp', 'help centre', 'support agent'],
    sections: [
      {
        id: 'inbox',
        heading: 'The inbox',
        body: (
          <>
            <P>Open the <UI>Support</UI> tool. <UI>Inbox</UI> collects conversations from the widget (and from email, SMS and WhatsApp once those channels are connected), filtered by <UI>Open</UI>, <UI>Closed</UI> or <UI>All</UI>. <UI>Tickets</UI> shows what those conversations turned into.</P>
            <Shot name="support" alt="The Support tool with the Inbox, Tickets and Agent tabs" />
          </>
        ),
      },
      {
        id: 'agent',
        heading: 'Turn on the support agent',
        body: (
          <>
            <Steps>
              <li>In <UI>Support</UI>, open the <UI>Agent</UI> tab.</li>
              <li>Pick a <UI>Support agent</UI> and press <UI>Save</UI>. A <UI>Chat with Agent</UI> card appears on the widget's home screen.</li>
            </Steps>
            <Shot name="support-agent" alt="The support agent settings with the agent picker and what the agent can reach" />
            <P>The support agent talks to visitors, gathers the details, checks for duplicates, and proposes a ticket the visitor confirms. Because public conversations are untrusted, it can only search and propose tickets: it can't read your code, run commands or see secrets.</P>
          </>
        ),
      },
      {
        id: 'channels',
        heading: 'Email, phone and help centre',
        body: (
          <>
            <P>Connect more channels in the project's settings: email on your own domain (replies land in the inbox), and phone, SMS and WhatsApp through your Twilio account. Publish help articles from the <UI>Help</UI> section; the chat agent can draft them, marked for you to check before they go live.</P>
          </>
        ),
      },
    ],
  },

  {
    path: '/docs/support/users-and-sales',
    group: 'Support & sales',
    title: 'Users, leads and sales',
    lede: 'Everyone who uses or visits your product, where they are in your pipeline, and the outreach that moves them along.',
    keywords: ['users', 'crm', 'leads', 'pipeline', 'sales', 'calls', 'import', 'outreach', 'stage'],
    sections: [
      {
        id: 'users',
        heading: 'The Users tool',
        body: (
          <>
            <P><UI>Users</UI> lists everyone the SDK has seen: members who signed in through the widget and anonymous visitors before they do. Filter by pipeline stage (<UI>Visitor</UI>, <UI>Lead</UI>, <UI>Qualified</UI>, <UI>Trial</UI>, <UI>Converted</UI>) or by role.</P>
            <Shot name="users" alt="The Users tool with the stage filter and a table of visitors" />
            <P>Extra columns such as company or plan come from the identity your app signs (see <NL to="/docs/support/widget#identify">Identify signed-in users</NL>). Open a person to see their timeline and reach them by note, email, SMS, WhatsApp or call.</P>
          </>
        ),
      },
      {
        id: 'leads',
        heading: 'Import leads',
        body: <P>Press <UI>Import leads</UI> to upload a CSV of people you want to reach. They join the list as leads, ready for outreach.</P>,
      },
      {
        id: 'sales',
        heading: 'Sales calls',
        body: (
          <>
            <P>The <UI>Sales</UI> tool runs AI callers that phone your people, the campaigns they run, and a log of every call. Because an agent placing calls is regulated like a robocall, RunHQ turns Sales on server by server after checking who you will call and how they agreed to it.</P>
            <Shot name="sales" alt="The Sales tool explaining that Sales needs to be enabled for the server" />
            <P>To request it, email <a className="rhpd-link" href="mailto:support@runhq.io">support@runhq.io</a> from the server owner's account. You also need your own Twilio account connected under <UI>Settings › Twilio</UI>.</P>
          </>
        ),
      },
    ],
  },

  {
    path: '/docs/support/errors-analytics',
    group: 'Support & sales',
    title: 'Errors and analytics',
    lede: 'See what breaks in production and where people drop off, then hand either to an agent.',
    keywords: ['errors', 'exceptions', 'sentry', 'analytics', 'retention', 'funnel', 'evolve', 'experiments'],
    sections: [
      {
        id: 'errors',
        heading: 'Errors',
        body: (
          <>
            <P>With the SDK installed, the <UI>Errors</UI> tool groups the exceptions your product throws, from the browser and (with the server SDK) your backend. Filter by time range, status (<UI>Open</UI>, <UI>Ignored</UI>, <UI>Resolved</UI>), source and environment.</P>
            <Shot name="errors" alt="The Errors tool with time range, status, source and environment filters" />
            <P>Open an error to see its stack trace and history, then resolve it, ignore it, or press <UI>Fix with agent</UI> to file a task with everything attached.</P>
          </>
        ),
      },
      {
        id: 'analytics',
        heading: 'Analytics',
        body: (
          <>
            <P><UI>Analytics</UI> shows where first-time users drop out (<UI>Progression</UI>), how long they stay (<UI>Engagement</UI>), and your own <UI>Metrics</UI>. Funnel stages come from the SDK's <code>.stage</code> calls.</P>
            <Shot name="analytics" alt="The Analytics tool with Progression, Engagement and Metrics tabs" />
          </>
        ),
      },
      {
        id: 'evolve',
        heading: 'Evolve (beta)',
        body: (
          <>
            <H3>Experiments on real visitors</H3>
            <P><UI>Evolve</UI> tries variations of your product on real visitors, measures them against a goal, and keeps what works. Agents build the variations; you approve what ships. It uses the SDK's <code>.variation</code> calls and can read goals from Mixpanel, PostHog or your own API.</P>
            <Callout>Evolve is in beta. Talk to us if you'd like help setting up your first experiment.</Callout>
          </>
        ),
      },
    ],
  },
];

