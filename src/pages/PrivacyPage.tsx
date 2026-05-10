import { Navbar, Footer } from '../components/chrome';

export default function PrivacyPage() {
  return (
    <div className="rhp-root rhl-root">
      <style>{LEGAL_STYLES}</style>
      <Navbar />

      <section className="rhp-hero">
        <div className="rhp-hero-eyebrow">Legal · Privacy policy</div>
        <h1 className="rhp-hero-h1">Privacy policy.</h1>
        <p className="rhp-hero-lede">
          How RunHQ Solutions Inc. collects, uses, shares, and protects information.
          Effective 2026-05-10.
        </p>
      </section>

      <article className="rhl-doc">
        <section className="rhl-sec">
          <h2>1. Introduction</h2>
          <p>
            RunHQ Solutions Inc. (“RunHQ,” “we,” “us,” or “our”) operates the RunHQ platform —
            a hosted service that lets teams capture product feedback, run AI coding agents,
            review proposed code changes, and ship software. This Privacy Policy describes the
            categories of information we collect when you use the platform, our website at
            <em> runhq.io</em>, and related services (together, the “Services”), how we use
            and share that information, and the rights and choices you have.
          </p>
          <p>
            This Policy applies to information collected through the Services. It does not
            apply to data your organization processes through self-hosted tools we do not
            operate, or to third-party services you connect to the Services (for example,
            GitHub, Linear, Slack, or external AI providers), which are governed by their own
            policies.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>2. Roles: controller and processor</h2>
          <p>
            For account-level information (your name, email, billing details, support
            interactions, and platform telemetry tied to your account), RunHQ acts as a
            <strong> data controller</strong>. For workspace content your organization submits
            to the Services — todos, comments, code, attachments, agent runs, and similar — we
            act as a <strong>processor</strong> on behalf of the customer organization
            (typically your employer), which is the controller of that content.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>3. Information we collect</h2>
          <h3>a. Information you provide</h3>
          <ul>
            <li><strong>Account &amp; profile:</strong> name, work email, organization, job role, and password (hashed). If you sign in with a third-party identity provider, we receive the identifying data that provider releases to us.</li>
            <li><strong>Workspace content:</strong> todos, projects, comments, attachments, codebases connected through integrations, agent run inputs and outputs, review decisions, and any other content you create or upload through the Services.</li>
            <li><strong>Billing details:</strong> billing contact, address, plan selection, tax identifiers where required, and payment metadata. Card numbers are entered directly with our payment processor and are not stored on our servers.</li>
            <li><strong>Communications:</strong> support tickets, in-product chats, survey responses, and emails you send us.</li>
          </ul>
          <h3>b. Information we collect automatically</h3>
          <ul>
            <li><strong>Device &amp; connection data:</strong> IP address, user-agent, device type, operating system, browser, language, and approximate location derived from IP.</li>
            <li><strong>Product telemetry:</strong> pages and features used, clicks, agent run metadata (duration, tokens, status), error traces, and similar usage events.</li>
            <li><strong>Cookies &amp; similar technologies:</strong> see Section 11.</li>
          </ul>
          <h3>c. Information from third parties</h3>
          <ul>
            <li><strong>Identity providers</strong> (e.g., Google, GitHub, your SSO) — basic profile and authentication tokens.</li>
            <li><strong>Connected integrations</strong> (e.g., GitHub, Linear, Slack, Intercom) — only the data you authorize the integration to share with the Services.</li>
            <li><strong>Billing &amp; fraud-prevention vendors</strong> — payment confirmations, chargeback notices, risk signals.</li>
          </ul>
        </section>

        <section className="rhl-sec">
          <h2>4. How we use information</h2>
          <ul>
            <li><strong>Operate the Services:</strong> authenticate users, route todos, execute agent runs, deliver notifications, persist workspace content.</li>
            <li><strong>Bill and account:</strong> process subscriptions and invoices, issue receipts, manage seat counts and credit balances.</li>
            <li><strong>Support:</strong> respond to questions, troubleshoot incidents, communicate about your account.</li>
            <li><strong>Security:</strong> detect and prevent abuse, fraud, and unauthorized access; investigate incidents; enforce our Terms.</li>
            <li><strong>Improve and develop:</strong> measure feature adoption, debug, and design product changes — using aggregated and anonymized data wherever practical.</li>
            <li><strong>Legal compliance:</strong> meet tax, accounting, audit, and legal-process obligations.</li>
          </ul>
          <p>
            We do <strong>not</strong> use customer workspace content to train our own foundation
            models, and we do not sell personal information.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>5. Legal bases (EEA / UK)</h2>
          <p>If you are in the European Economic Area or United Kingdom, we rely on:</p>
          <ul>
            <li><strong>Contract</strong> — to provide the Services to you under our Terms.</li>
            <li><strong>Legitimate interests</strong> — to secure, maintain, and improve the Services, prevent abuse, and run our business, balanced against your rights.</li>
            <li><strong>Consent</strong> — for non-essential cookies and any optional communications, withdrawable at any time.</li>
            <li><strong>Legal obligation</strong> — to comply with applicable law and lawful requests.</li>
          </ul>
        </section>

        <section className="rhl-sec">
          <h2>6. AI and coding agents</h2>
          <p>
            When you trigger an agent run, the inputs you select (prompt, related context,
            relevant files) are transmitted to the AI provider you have chosen — for example,
            Anthropic (Claude) or OpenAI (Codex). Those providers process the data under their
            own terms and privacy commitments, which we have reviewed before integrating.
            We pass along your organization's no-training preferences where the provider
            supports them.
          </p>
          <p>
            Agent outputs are returned to your workspace and treated as your customer content.
            We log run metadata (duration, status, token counts) to support billing,
            reliability, and audit, and we retain inputs and outputs for the period defined
            in Section 9.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>7. How we share information</h2>
          <p>We share information only with the following categories of recipients:</p>
          <ul>
            <li><strong>Subprocessors</strong> — vetted vendors who process data on our behalf to operate the Services. Categories include cloud infrastructure (compute, storage, CDN), AI providers when invoked by your runs, error monitoring and observability, customer support, transactional email, analytics, and payment processing. A current subprocessor list is available on request.</li>
            <li><strong>Within your organization</strong> — workspace content is visible to authorized members of your workspace per the access controls your administrators configure.</li>
            <li><strong>Connected integrations</strong> — only the data you direct us to send (for example, opening an issue in your linked GitHub repo).</li>
            <li><strong>Professional advisers</strong> — auditors, lawyers, and accountants under duties of confidentiality.</li>
            <li><strong>Corporate transactions</strong> — a successor entity in a merger, acquisition, financing, or sale of assets, subject to commitments at least as protective as this Policy.</li>
            <li><strong>Compliance and safety</strong> — law enforcement, regulators, or other parties when we believe disclosure is required by law or necessary to protect rights, property, or safety. We push back on overbroad requests.</li>
          </ul>
          <p>
            We do not sell or rent personal information, and we do not share it for
            cross-context behavioral advertising.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>8. International transfers</h2>
          <p>
            We are based in Canada and our primary infrastructure runs in North American
            regions. If you access the Services from another country, your information will be
            transferred to and processed in jurisdictions whose laws may differ from those of
            your home country. Where required, we use Standard Contractual Clauses, the UK IDTA
            or equivalent transfer mechanisms with our subprocessors.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>9. Data retention</h2>
          <ul>
            <li><strong>Account data</strong> — retained for the life of the account and a short period afterward to handle billing reconciliation, audit, and dispute resolution.</li>
            <li><strong>Workspace content</strong> — retained while the workspace is active. After deletion, content is removed from primary systems within 30 days; encrypted backups roll off within 90 days.</li>
            <li><strong>Telemetry &amp; logs</strong> — retained on a rolling 13-month window, except where a security investigation or legal hold requires longer retention.</li>
            <li><strong>Billing records</strong> — retained for as long as required by tax and accounting law (typically 7 years).</li>
          </ul>
          <p>
            You can request earlier deletion of your personal data by contacting us; we will
            honor the request unless we have a legal basis to retain.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>10. Security</h2>
          <p>
            We use administrative, technical, and physical safeguards designed to protect
            information against unauthorized access, disclosure, alteration, and destruction —
            including encryption in transit and at rest, role-based access controls,
            least-privilege production access, audit logging, vulnerability management, and
            secure development practices. No system is impenetrable; if we ever experience a
            breach affecting your information, we will notify you in line with applicable law.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>11. Cookies and similar technologies</h2>
          <p>We use a small number of cookies and similar technologies:</p>
          <ul>
            <li><strong>Strictly necessary</strong> — sign-in sessions, security tokens, basic load balancing.</li>
            <li><strong>Functional</strong> — remember your preferences (theme, recent workspace).</li>
            <li><strong>Analytics</strong> — aggregate usage measurement to improve the product.</li>
          </ul>
          <p>
            You can disable non-essential cookies via your browser. Disabling strictly
            necessary cookies will prevent core functionality from working. We honor Global
            Privacy Control signals where applicable.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>12. Your rights and choices</h2>
          <p>
            Depending on where you live, you may have the right to access, correct, port,
            delete, or restrict the processing of your personal data, to object to certain
            processing, and to withdraw consent. California residents have specific rights
            under the CCPA/CPRA, including the right to know, delete, correct, and opt out of
            the sale or sharing of personal information (we do neither). To exercise your
            rights, email <a className="rhl-link" href="mailto:admin@runhq.io">admin@runhq.io</a>.
            We will verify your request and respond within the period required by law.
            You may also lodge a complaint with your local data-protection authority.
          </p>
          <p>
            If your data is processed at the direction of an organization that uses RunHQ
            (your employer, for instance), we will refer your request to that organization and
            assist them in responding.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>13. Children's privacy</h2>
          <p>
            The Services are intended for business users and are not directed at children
            under 16. We do not knowingly collect personal information from children. If you
            believe a child has provided us information, please contact us so we can delete it.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>14. Third-party links</h2>
          <p>
            The Services may link to third-party sites or invoke third-party tools. We are not
            responsible for the privacy practices of those third parties; review their
            policies before sharing information with them.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>15. Changes to this Policy</h2>
          <p>
            We may update this Policy from time to time. The “Effective” date at the top
            indicates the latest revision. For material changes, we will give notice by
            email or in-product before the change takes effect. Continued use of the Services
            after the effective date indicates acceptance of the updated Policy.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>16. Contact us</h2>
          <p>
            <strong>RunHQ Solutions Inc.</strong>, Vancouver, British Columbia, Canada.
          </p>
          <p>
            Privacy and data-protection inquiries:{' '}
            <a className="rhl-link" href="mailto:admin@runhq.io">admin@runhq.io</a>.
          </p>
        </section>

        <p className="rhl-disclaimer">
          This Policy is provided for transparency about our practices and is not legal advice.
          For specific questions about how it applies to you, contact us directly.
        </p>
      </article>

      <Footer />
    </div>
  );
}

export const LEGAL_STYLES = `
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

  .rhp-hero { padding: 80px 48px 36px; text-align: center; max-width: 800px; margin: 0 auto; }
  .rhp-hero-eyebrow {
    display: inline-block; padding: 4px 11px;
    background: var(--rhw-bg-2); border: 1px solid var(--rhw-line);
    border-radius: 999px; font-size: 11.5px; color: var(--rhw-ink-soft);
    letter-spacing: 0.04em; margin-bottom: 22px;
  }
  .rhp-hero-h1 {
    font-size: 48px; line-height: 1.05; letter-spacing: -0.03em;
    font-weight: 600; margin: 0 0 18px; text-wrap: balance;
  }
  .rhp-hero-lede {
    font-size: 17px; line-height: 1.55; color: var(--rhw-ink-soft);
    max-width: 620px; margin: 0 auto; text-wrap: pretty;
  }

  .rhl-doc {
    max-width: 760px; margin: 0 auto; padding: 24px 48px 96px;
    color: var(--rhw-ink-soft); font-size: 15px; line-height: 1.65;
  }
  .rhl-sec { padding: 28px 0; border-top: 1px solid var(--rhw-line-soft); }
  .rhl-sec:first-child { border-top: none; }
  .rhl-sec h2 {
    font-size: 19px; font-weight: 600;
    color: var(--rhw-ink); margin: 0 0 12px;
    letter-spacing: -0.012em;
  }
  .rhl-sec h3 {
    font-size: 15px; font-weight: 600;
    color: var(--rhw-ink); margin: 18px 0 8px;
    letter-spacing: -0.005em;
  }
  .rhl-sec p { margin: 0 0 12px; }
  .rhl-sec p:last-child { margin-bottom: 0; }
  .rhl-sec ul, .rhl-sec ol {
    margin: 8px 0 12px; padding-left: 20px;
  }
  .rhl-sec li { margin-bottom: 6px; }
  .rhl-sec strong { color: var(--rhw-ink); font-weight: 600; }
  .rhl-sec em { font-style: italic; }
  .rhl-link { color: var(--rhw-accent) !important; }
  .rhl-link:hover { text-decoration: underline; }
  .rhl-disclaimer {
    margin-top: 36px; padding-top: 24px;
    border-top: 1px solid var(--rhw-line-soft);
    font-size: 13px; color: var(--rhw-ink-mute);
    font-style: italic;
  }

  @media (max-width: 880px) {
    .rhp-hero { padding: 56px 24px 24px; }
    .rhp-hero-h1 { font-size: 34px; }
    .rhl-doc { padding: 16px 24px 64px; }
  }
`;
