import { Navbar, Footer } from '../components/chrome';
import { LEGAL_STYLES } from './PrivacyPage';

export default function TermsPage() {
  return (
    <div className="rhp-root rhl-root">
      <style>{LEGAL_STYLES}</style>
      <Navbar />

      <section className="rhp-hero">
        <div className="rhp-hero-eyebrow">Legal · Terms of service</div>
        <h1 className="rhp-hero-h1">Terms of service.</h1>
        <p className="rhp-hero-lede">
          The agreement between you and RunHQ Solutions Inc. when you use the Services.
          Effective 2026-05-10.
        </p>
      </section>

      <article className="rhl-doc">
        <section className="rhl-sec">
          <h2>1. Agreement</h2>
          <p>
            These Terms of Service (the “Terms”) form a binding agreement between
            <strong> RunHQ Solutions Inc.</strong>, a corporation incorporated under the laws
            of British Columbia, Canada (“RunHQ,” “we,” “us,” or “our”), and you, the
            individual or entity accepting these Terms (“you” or “Customer”). By creating an
            account, accessing, or using the Services, you agree to be bound by these Terms.
            If you do not agree, do not use the Services.
          </p>
          <p>
            If you are entering into these Terms on behalf of a company or other organization,
            you represent that you have authority to bind that organization, and “you” refers
            to that organization. A separate signed master services agreement, if any,
            controls over these Terms to the extent of any conflict.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>2. Definitions</h2>
          <ul>
            <li><strong>Services</strong> — the RunHQ platform, websites, APIs, and related products and documentation.</li>
            <li><strong>Customer Content</strong> — todos, code, comments, attachments, prompts, agent inputs and outputs, and any other data you submit to the Services.</li>
            <li><strong>Authorized User</strong> — an employee, contractor, or other individual you authorize to use the Services through your account.</li>
            <li><strong>Subscription</strong> — your selected plan and associated entitlements.</li>
            <li><strong>Order</strong> — an in-product checkout or signed order document referencing these Terms.</li>
          </ul>
        </section>

        <section className="rhl-sec">
          <h2>3. Eligibility</h2>
          <p>
            You must be at least 18 years old, capable of forming a binding contract under
            applicable law, and not barred from receiving services under the laws of Canada
            or any other applicable jurisdiction. The Services are intended for business and
            professional use.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>4. Accounts and security</h2>
          <ul>
            <li>You are responsible for activity that occurs under your account, including the actions of your Authorized Users.</li>
            <li>Provide accurate, current registration and billing information and keep it up to date.</li>
            <li>Keep credentials secure. Do not share an account login among multiple individuals; provision additional Authorized User seats instead.</li>
            <li>Notify us promptly of any suspected unauthorized access at <a className="rhl-link" href="mailto:admin@runhq.io">admin@runhq.io</a>.</li>
          </ul>
        </section>

        <section className="rhl-sec">
          <h2>5. The Services</h2>
          <p>
            We grant you a limited, non-exclusive, non-transferable, revocable right to access
            and use the Services during your subscription term, in accordance with these Terms,
            our documentation, and the entitlements of your Subscription. We may add to, modify,
            or remove features over time and will give reasonable notice before changes that
            materially reduce core functionality.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>6. Subscriptions, fees, and billing</h2>
          <ul>
            <li><strong>Plans.</strong> Paid plans are billed monthly or annually in advance. Plan details, including platform fee, per-seat pricing, and included credits, are shown at checkout.</li>
            <li><strong>Agent credit.</strong> Agent runs consume credit at the rates we publish. Credit refreshes at the start of each billing cycle and does not roll over unless your plan says it does.</li>
            <li><strong>Overages.</strong> Where overage usage is permitted, it is billed in arrears at the published rate.</li>
            <li><strong>Taxes.</strong> Prices are exclusive of taxes. You are responsible for any sales, use, value-added, withholding, or similar taxes other than taxes based on our income.</li>
            <li><strong>Payment.</strong> You authorize us and our payment processor to charge your selected payment method on a recurring basis. Failed payments may result in suspension after written notice.</li>
            <li><strong>Refunds.</strong> Fees are non-refundable except where required by law or where we expressly agree in writing.</li>
            <li><strong>Price changes.</strong> We may change prices effective on your next renewal term, with at least 30 days' notice.</li>
          </ul>
        </section>

        <section className="rhl-sec">
          <h2>7. Trials and credits</h2>
          <p>
            We may offer free trials, evaluation accounts, or promotional credits. These are
            provided “as is,” may be limited in scope or duration, and may be modified or
            terminated at any time. At the end of a trial, your account converts to a paid
            plan unless you cancel before the trial expires.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>8. Cancellation and termination</h2>
          <ul>
            <li>You may cancel your Subscription at any time from <em>Settings → Billing</em>. Cancellation takes effect at the end of the current paid period; you keep access until then.</li>
            <li>We may suspend or terminate the Services for material breach of these Terms, non-payment after notice, or where required by law. We will use reasonable efforts to notify you in advance.</li>
            <li>On termination, your right to use the Services ends. We will make Customer Content available for export for 30 days after termination, after which we may delete it consistent with our Privacy Policy.</li>
            <li>Sections that by their nature should survive termination — including IP, confidentiality, disclaimers, limitations of liability, indemnification, governing law, and dispute resolution — survive.</li>
          </ul>
        </section>

        <section className="rhl-sec">
          <h2>9. Customer Content</h2>
          <p>
            You retain all right, title, and interest in Customer Content. You grant us a
            worldwide, non-exclusive, royalty-free license to host, copy, transmit, display,
            and process Customer Content solely as needed to provide and improve the Services
            for you, including by transmitting prompts and context to AI providers when you
            invoke them. You represent that you have the rights necessary to grant this
            license and that Customer Content does not infringe third-party rights or violate
            applicable law.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>10. Acceptable use</h2>
          <p>You agree not to, and not to permit any Authorized User to:</p>
          <ul>
            <li>Use the Services to build, train, evaluate, or benchmark a competing product or model;</li>
            <li>Reverse engineer, decompile, or attempt to derive source code, except to the limited extent applicable law expressly permits and we cannot contractually prohibit;</li>
            <li>Send malware, spam, or content that is unlawful, infringing, defamatory, harassing, or hateful;</li>
            <li>Probe, scan, or test the vulnerability of the Services other than under a written authorization;</li>
            <li>Interfere with or disrupt the integrity or performance of the Services;</li>
            <li>Use the Services to violate the rights of any third party or any applicable law, including export-control and sanctions law.</li>
          </ul>
          <p>We may suspend access to address suspected violations and will notify you when we do.</p>
        </section>

        <section className="rhl-sec">
          <h2>11. Coding agents and generated output</h2>
          <p>
            The Services orchestrate AI coding agents (for example, Anthropic Claude or
            OpenAI Codex) on your behalf. AI output is probabilistic: it may be incorrect,
            insecure, or unsuitable for your purpose. <strong>You are solely responsible for
            reviewing, testing, and validating any agent-produced code or other artifact
            before merging, deploying, or otherwise relying on it.</strong>
          </p>
          <p>
            We do not warrant that agent output is original, non-infringing, or fit for any
            particular purpose. Where the underlying AI provider's terms require us to pass
            through certain commitments (or limit certain rights), those terms are
            incorporated by reference and made available on request.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>12. Third-party services</h2>
          <p>
            The Services may integrate with third-party products (e.g., GitHub, Linear, Slack,
            Intercom, identity providers, and AI providers). Your use of those products is
            governed by their own terms. We are not responsible for third-party products and
            do not guarantee their continued availability.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>13. Intellectual property</h2>
          <p>
            We and our licensors retain all right, title, and interest in the Services,
            including software, designs, trademarks, and documentation. No rights are granted
            except as expressly stated in these Terms. The “RunHQ” name and logo are
            trademarks of RunHQ Solutions Inc. and may not be used without our prior written
            permission, except for permitted descriptive use.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>14. Feedback</h2>
          <p>
            If you give us suggestions or feedback about the Services, you grant us a
            perpetual, irrevocable, royalty-free, worldwide license to use it without
            restriction. We are not obligated to act on any feedback or to keep it
            confidential.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>15. Confidentiality</h2>
          <p>
            Each party may receive non-public information of the other (“Confidential
            Information”). The receiving party will use the same degree of care it uses to
            protect its own confidential information of similar importance (and in any event
            no less than reasonable care), use Confidential Information only to perform under
            these Terms, and not disclose it except to representatives bound by similar
            obligations. Confidential Information does not include information that is or
            becomes public, was lawfully known before disclosure, is independently developed
            without use of Confidential Information, or is rightfully obtained from a third
            party without restriction.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>16. Privacy and data protection</h2>
          <p>
            Our processing of personal data is described in our{' '}
            <a className="rhl-link" href="/privacy">Privacy Policy</a>. For Customer Content
            that contains personal data subject to GDPR, UK GDPR, or similar laws, our Data
            Processing Addendum (available on request) is incorporated into these Terms by
            reference.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>17. Disclaimers</h2>
          <p>
            <strong>The Services are provided “as is” and “as available.”</strong> To the
            maximum extent permitted by applicable law, RunHQ disclaims all warranties,
            whether express, implied, statutory, or otherwise, including warranties of
            merchantability, fitness for a particular purpose, title, non-infringement, and
            any warranty arising from a course of dealing or usage of trade. We do not warrant
            that the Services will be uninterrupted, error-free, secure, or free of harmful
            components, or that defects will be corrected.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>18. Indemnification</h2>
          <p>
            You will defend, indemnify, and hold harmless RunHQ and its officers, directors,
            employees, and agents from and against any third-party claim arising out of or
            related to (a) Customer Content, (b) your or your Authorized Users' use of the
            Services in violation of these Terms or applicable law, or (c) your use of any
            agent-generated output. We will promptly notify you of any such claim, give you
            sole control of the defense and settlement (subject to settlement that does not
            require an admission or payment by us), and provide reasonable cooperation.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>19. Limitation of liability</h2>
          <p>
            To the maximum extent permitted by applicable law: (a) <strong>neither party will
            be liable for any indirect, incidental, special, consequential, exemplary, or
            punitive damages</strong>, or for lost profits, revenue, data, goodwill, or
            business interruption, even if advised of the possibility; and (b) <strong>each
            party's aggregate liability for any claim arising out of or relating to these
            Terms or the Services is limited to the fees you paid us for the Services in the
            twelve (12) months preceding the event giving rise to the claim.</strong>
          </p>
          <p>
            These limits do not apply to: (i) your obligations to pay fees, (ii) your
            obligations under Sections 10 (Acceptable use) or 18 (Indemnification),
            (iii) either party's gross negligence, willful misconduct, or fraud, or
            (iv) liabilities that cannot be limited under applicable law.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>20. Governing law and venue</h2>
          <p>
            These Terms are governed by the laws of the Province of British Columbia and the
            federal laws of Canada applicable in British Columbia, without regard to conflict
            of laws principles. The United Nations Convention on Contracts for the
            International Sale of Goods does not apply. The parties submit to the exclusive
            jurisdiction of the courts of Vancouver, British Columbia for any dispute not
            subject to arbitration.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>21. Dispute resolution</h2>
          <p>
            Before filing any claim, the parties will try in good faith to resolve the dispute
            informally for at least 30 days after written notice. Disputes that cannot be
            resolved informally will be resolved on an individual basis — class actions,
            class arbitrations, and representative actions are not permitted to the maximum
            extent allowed by law. If you are a consumer in a jurisdiction whose law
            invalidates this provision, it does not apply to you.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>22. Force majeure</h2>
          <p>
            Neither party is liable for failure or delay caused by events beyond its
            reasonable control, including acts of nature, war, civil unrest, labor action,
            internet or utility outages, attacks on infrastructure, pandemics, or government
            action. Affected obligations are suspended for the duration of the event;
            payment obligations are not suspended for routine, customer-side outages.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>23. Export and sanctions</h2>
          <p>
            You will comply with all applicable export-control and sanctions laws, including
            those of Canada, the United States, the United Kingdom, and the European Union.
            You represent that you and your Authorized Users are not subject to sanctions
            that would prohibit your use of the Services.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>24. Assignment</h2>
          <p>
            You may not assign these Terms without our prior written consent, except to an
            affiliate or in connection with a merger, acquisition, or sale of substantially
            all of your assets, provided the assignee is not a competitor of RunHQ. We may
            assign these Terms in connection with a corporate transaction. Any non-permitted
            assignment is void.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>25. Notices</h2>
          <p>
            Notices to RunHQ must be sent to{' '}
            <a className="rhl-link" href="mailto:admin@runhq.io">admin@runhq.io</a>. Notices
            to you may be given by email to the address on your account or by in-product
            notification, and are deemed received on the day sent.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>26. Severability and waiver</h2>
          <p>
            If any provision of these Terms is held unenforceable, the remaining provisions
            stay in effect, and the unenforceable provision is reformed to the minimum extent
            necessary to make it enforceable. Failure to enforce a provision is not a waiver.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>27. Entire agreement</h2>
          <p>
            These Terms (together with any Order, the Privacy Policy, and any DPA referenced
            here) constitute the entire agreement between the parties regarding the Services
            and supersede all prior agreements and understandings on that subject. Pre-printed
            terms in any purchase order are rejected.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>28. Changes to these Terms</h2>
          <p>
            We may update these Terms from time to time. The “Effective” date at the top
            indicates the latest revision. For material changes, we will provide reasonable
            advance notice by email or in-product. If you do not agree to a change, your
            sole remedy is to stop using the Services and cancel your Subscription before the
            change takes effect.
          </p>
        </section>

        <section className="rhl-sec">
          <h2>29. Contact</h2>
          <p>
            <strong>RunHQ Solutions Inc.</strong>, Vancouver, British Columbia, Canada.
          </p>
          <p>
            Questions about these Terms:{' '}
            <a className="rhl-link" href="mailto:admin@runhq.io">admin@runhq.io</a>.
          </p>
        </section>

        <p className="rhl-disclaimer">
          These Terms describe our standard commercial relationship and are not legal advice.
          For specific questions, contact us directly.
        </p>
      </article>

      <Footer />
    </div>
  );
}
