import { Link } from 'react-router-dom';
import { Navbar, Footer } from '../components/chrome';
import { LEGAL_STYLES } from './PrivacyPage';
import { useT } from '../i18n/context';

const TERMS_T = {
  en: {
    eyebrow: 'Legal · Terms of service',
    h1: 'Terms of service.',
    ledePre: 'The agreement between you and RunHQ Solutions Inc. when you use the Services. Effective ',
    ledeDate: '2026-05-10',
    ledeSuffix: '.',

    // 1. Agreement
    s1H: '1. Agreement',
    s1p1Pre: 'These Terms of Service (the “Terms”) form a binding agreement between',
    s1p1Strong: ' RunHQ Solutions Inc.',
    s1p1Post: ', a corporation incorporated under the laws of British Columbia, Canada (“RunHQ,” “we,” “us,” or “our”), and you, the individual or entity accepting these Terms (“you” or “Customer”). By creating an account, accessing, or using the Services, you agree to be bound by these Terms. If you do not agree, do not use the Services.',
    s1p2: 'If you are entering into these Terms on behalf of a company or other organization, you represent that you have authority to bind that organization, and “you” refers to that organization. A separate signed master services agreement, if any, controls over these Terms to the extent of any conflict.',

    // 2. Definitions
    s2H: '2. Definitions',
    li2_1Label: 'Services',
    li2_1Body: ' — the RunHQ platform, websites, APIs, and related products and documentation.',
    li2_2Label: 'Customer Content',
    li2_2Body: ' — todos, code, comments, attachments, prompts, agent inputs and outputs, and any other data you submit to the Services.',
    li2_3Label: 'Authorized User',
    li2_3Body: ' — an employee, contractor, or other individual you authorize to use the Services through your account.',
    li2_4Label: 'Subscription',
    li2_4Body: ' — your selected plan and associated entitlements.',
    li2_5Label: 'Order',
    li2_5Body: ' — an in-product checkout or signed order document referencing these Terms.',

    // 3. Eligibility
    s3H: '3. Eligibility',
    s3p1: 'You must be at least 18 years old, capable of forming a binding contract under applicable law, and not barred from receiving services under the laws of Canada or any other applicable jurisdiction. The Services are intended for business and professional use.',

    // 4. Accounts and security
    s4H: '4. Accounts and security',
    li4_1: 'You are responsible for activity that occurs under your account, including the actions of your Authorized Users.',
    li4_2: 'Provide accurate, current registration and billing information and keep it up to date.',
    li4_3: 'Keep credentials secure. Do not share an account login among multiple individuals; provision additional Authorized User seats instead.',
    li4_4Pre: 'Notify us promptly of any suspected unauthorized access at ',
    li4_4Suffix: '.',

    // 5. The Services
    s5H: '5. The Services',
    s5p1: 'We grant you a limited, non-exclusive, non-transferable, revocable right to access and use the Services during your subscription term, in accordance with these Terms, our documentation, and the entitlements of your Subscription. We may add to, modify, or remove features over time and will give reasonable notice before changes that materially reduce core functionality.',

    // 6. Subscriptions, fees, and billing
    s6H: '6. Subscriptions, fees, and billing',
    li6_1Label: 'Plans.',
    li6_1Body: ' Paid plans are billed monthly or annually in advance. Plan details, including platform fee, per-seat pricing, and included credits, are shown at checkout.',
    li6_2Label: 'Agent credit.',
    li6_2Body: ' Agent runs consume credit at the rates we publish. Credit refreshes at the start of each billing cycle and does not roll over unless your plan says it does.',
    li6_3Label: 'Overages.',
    li6_3Body: ' Where overage usage is permitted, it is billed in arrears at the published rate.',
    li6_4Label: 'Taxes.',
    li6_4Body: ' Prices are exclusive of taxes. You are responsible for any sales, use, value-added, withholding, or similar taxes other than taxes based on our income.',
    li6_5Label: 'Payment.',
    li6_5Body: ' You authorize us and our payment processor to charge your selected payment method on a recurring basis. Failed payments may result in suspension after written notice.',
    li6_6Label: 'Refunds.',
    li6_6Body: ' Fees are non-refundable except where required by law or where we expressly agree in writing.',
    li6_7Label: 'Price changes.',
    li6_7Body: " We may change prices effective on your next renewal term, with at least 30 days' notice.",

    // 7. Trials and credits
    s7H: '7. Trials and credits',
    s7p1: 'We may offer free trials, evaluation accounts, or promotional credits. These are provided “as is,” may be limited in scope or duration, and may be modified or terminated at any time. At the end of a trial, your account converts to a paid plan unless you cancel before the trial expires.',

    // 8. Cancellation and termination
    s8H: '8. Cancellation and termination',
    li8_1Pre: 'You may cancel your Subscription at any time from ',
    li8_1Em: 'Settings → Billing',
    li8_1Post: '. Cancellation takes effect at the end of the current paid period; you keep access until then.',
    li8_2: 'We may suspend or terminate the Services for material breach of these Terms, non-payment after notice, or where required by law. We will use reasonable efforts to notify you in advance.',
    li8_3: 'On termination, your right to use the Services ends. We will make Customer Content available for export for 30 days after termination, after which we may delete it consistent with our Privacy Policy.',
    li8_4: 'Sections that by their nature should survive termination — including IP, confidentiality, disclaimers, limitations of liability, indemnification, governing law, and dispute resolution — survive.',

    // 9. Customer Content
    s9H: '9. Customer Content',
    s9p1: 'You retain all right, title, and interest in Customer Content. You grant us a worldwide, non-exclusive, royalty-free license to host, copy, transmit, display, and process Customer Content solely as needed to provide and improve the Services for you, including by transmitting prompts and context to AI providers when you invoke them. You represent that you have the rights necessary to grant this license and that Customer Content does not infringe third-party rights or violate applicable law.',

    // 10. Acceptable use
    s10H: '10. Acceptable use',
    s10p1: 'You agree not to, and not to permit any Authorized User to:',
    li10_1: 'Use the Services to build, train, evaluate, or benchmark a competing product or model;',
    li10_2: 'Reverse engineer, decompile, or attempt to derive source code, except to the limited extent applicable law expressly permits and we cannot contractually prohibit;',
    li10_3: 'Send malware, spam, or content that is unlawful, infringing, defamatory, harassing, or hateful;',
    li10_4: 'Probe, scan, or test the vulnerability of the Services other than under a written authorization;',
    li10_5: 'Interfere with or disrupt the integrity or performance of the Services;',
    li10_6: 'Use the Services to violate the rights of any third party or any applicable law, including export-control and sanctions law.',
    s10p2: 'We may suspend access to address suspected violations and will notify you when we do.',

    // 11. Coding agents and generated output
    s11H: '11. Coding agents and generated output',
    s11p1Pre: 'The Services orchestrate AI coding agents (for example, Anthropic Claude or OpenAI Codex) on your behalf. AI output is probabilistic: it may be incorrect, insecure, or unsuitable for your purpose. ',
    s11p1Strong: 'You are solely responsible for reviewing, testing, and validating any agent-produced code or other artifact before merging, deploying, or otherwise relying on it.',
    s11p2: "We do not warrant that agent output is original, non-infringing, or fit for any particular purpose. Where the underlying AI provider's terms require us to pass through certain commitments (or limit certain rights), those terms are incorporated by reference and made available on request.",

    // 12. Third-party services
    s12H: '12. Third-party services',
    s12p1: 'The Services may integrate with third-party products (e.g., GitHub, Linear, Slack, Intercom, identity providers, and AI providers). Your use of those products is governed by their own terms. We are not responsible for third-party products and do not guarantee their continued availability.',

    // 13. Intellectual property
    s13H: '13. Intellectual property',
    s13p1: 'We and our licensors retain all right, title, and interest in the Services, including software, designs, trademarks, and documentation. No rights are granted except as expressly stated in these Terms. The “RunHQ” name and logo are trademarks of RunHQ Solutions Inc. and may not be used without our prior written permission, except for permitted descriptive use.',

    // 14. Feedback
    s14H: '14. Feedback',
    s14p1: 'If you give us suggestions or feedback about the Services, you grant us a perpetual, irrevocable, royalty-free, worldwide license to use it without restriction. We are not obligated to act on any feedback or to keep it confidential.',

    // 15. Confidentiality
    s15H: '15. Confidentiality',
    s15p1: 'Each party may receive non-public information of the other (“Confidential Information”). The receiving party will use the same degree of care it uses to protect its own confidential information of similar importance (and in any event no less than reasonable care), use Confidential Information only to perform under these Terms, and not disclose it except to representatives bound by similar obligations. Confidential Information does not include information that is or becomes public, was lawfully known before disclosure, is independently developed without use of Confidential Information, or is rightfully obtained from a third party without restriction.',

    // 16. Privacy and data protection
    s16H: '16. Privacy and data protection',
    s16p1Pre: 'Our processing of personal data is described in our ',
    s16p1Link: 'Privacy Policy',
    s16p1Post: '. For Customer Content that contains personal data subject to GDPR, UK GDPR, or similar laws, our Data Processing Addendum (available on request) is incorporated into these Terms by reference.',

    // 17. Disclaimers
    s17H: '17. Disclaimers',
    s17p1Strong: 'The Services are provided “as is” and “as available.”',
    s17p1Post: ' To the maximum extent permitted by applicable law, RunHQ disclaims all warranties, whether express, implied, statutory, or otherwise, including warranties of merchantability, fitness for a particular purpose, title, non-infringement, and any warranty arising from a course of dealing or usage of trade. We do not warrant that the Services will be uninterrupted, error-free, secure, or free of harmful components, or that defects will be corrected.',

    // 18. Indemnification
    s18H: '18. Indemnification',
    s18p1: "You will defend, indemnify, and hold harmless RunHQ and its officers, directors, employees, and agents from and against any third-party claim arising out of or related to (a) Customer Content, (b) your or your Authorized Users' use of the Services in violation of these Terms or applicable law, or (c) your use of any agent-generated output. We will promptly notify you of any such claim, give you sole control of the defense and settlement (subject to settlement that does not require an admission or payment by us), and provide reasonable cooperation.",

    // 19. Limitation of liability
    s19H: '19. Limitation of liability',
    s19p1Pre: 'To the maximum extent permitted by applicable law: (a) ',
    s19p1Strong1: 'neither party will be liable for any indirect, incidental, special, consequential, exemplary, or punitive damages',
    s19p1Mid: ', or for lost profits, revenue, data, goodwill, or business interruption, even if advised of the possibility; and (b) ',
    s19p1Strong2: "each party's aggregate liability for any claim arising out of or relating to these Terms or the Services is limited to the fees you paid us for the Services in the twelve (12) months preceding the event giving rise to the claim.",
    s19p2: "These limits do not apply to: (i) your obligations to pay fees, (ii) your obligations under Sections 10 (Acceptable use) or 18 (Indemnification), (iii) either party's gross negligence, willful misconduct, or fraud, or (iv) liabilities that cannot be limited under applicable law.",

    // 20. Governing law and venue
    s20H: '20. Governing law and venue',
    s20p1: 'These Terms are governed by the laws of the Province of British Columbia and the federal laws of Canada applicable in British Columbia, without regard to conflict of laws principles. The United Nations Convention on Contracts for the International Sale of Goods does not apply. The parties submit to the exclusive jurisdiction of the courts of Vancouver, British Columbia for any dispute not subject to arbitration.',

    // 21. Dispute resolution
    s21H: '21. Dispute resolution',
    s21p1: 'Before filing any claim, the parties will try in good faith to resolve the dispute informally for at least 30 days after written notice. Disputes that cannot be resolved informally will be resolved on an individual basis — class actions, class arbitrations, and representative actions are not permitted to the maximum extent allowed by law. If you are a consumer in a jurisdiction whose law invalidates this provision, it does not apply to you.',

    // 22. Force majeure
    s22H: '22. Force majeure',
    s22p1: 'Neither party is liable for failure or delay caused by events beyond its reasonable control, including acts of nature, war, civil unrest, labor action, internet or utility outages, attacks on infrastructure, pandemics, or government action. Affected obligations are suspended for the duration of the event; payment obligations are not suspended for routine, customer-side outages.',

    // 23. Export and sanctions
    s23H: '23. Export and sanctions',
    s23p1: 'You will comply with all applicable export-control and sanctions laws, including those of Canada, the United States, the United Kingdom, and the European Union. You represent that you and your Authorized Users are not subject to sanctions that would prohibit your use of the Services.',

    // 24. Assignment
    s24H: '24. Assignment',
    s24p1: 'You may not assign these Terms without our prior written consent, except to an affiliate or in connection with a merger, acquisition, or sale of substantially all of your assets, provided the assignee is not a competitor of RunHQ. We may assign these Terms in connection with a corporate transaction. Any non-permitted assignment is void.',

    // 25. Notices
    s25H: '25. Notices',
    s25p1Pre: 'Notices to RunHQ must be sent to ',
    s25p1Post: '. Notices to you may be given by email to the address on your account or by in-product notification, and are deemed received on the day sent.',

    // 26. Severability and waiver
    s26H: '26. Severability and waiver',
    s26p1: 'If any provision of these Terms is held unenforceable, the remaining provisions stay in effect, and the unenforceable provision is reformed to the minimum extent necessary to make it enforceable. Failure to enforce a provision is not a waiver.',

    // 27. Entire agreement
    s27H: '27. Entire agreement',
    s27p1: 'These Terms (together with any Order, the Privacy Policy, and any DPA referenced here) constitute the entire agreement between the parties regarding the Services and supersede all prior agreements and understandings on that subject. Pre-printed terms in any purchase order are rejected.',

    // 28. Changes to these Terms
    s28H: '28. Changes to these Terms',
    s28p1: 'We may update these Terms from time to time. The “Effective” date at the top indicates the latest revision. For material changes, we will provide reasonable advance notice by email or in-product. If you do not agree to a change, your sole remedy is to stop using the Services and cancel your Subscription before the change takes effect.',

    // 29. Contact
    s29H: '29. Contact',
    s29p1Strong: 'RunHQ Solutions Inc.',
    s29p1Post: ', Vancouver, British Columbia, Canada.',
    s29p2Pre: 'Questions about these Terms: ',
    s29p2Suffix: '.',

    disclaimer: 'These Terms describe our standard commercial relationship and are not legal advice. For specific questions, contact us directly.',
  },
  ko: {
    eyebrow: '법적 고지 · 이용약관',
    h1: '이용약관.',
    ledePre: '귀하가 서비스를 이용할 때 RunHQ Solutions Inc.와 귀하 사이에 체결되는 계약입니다. 발효일 ',
    ledeDate: '2026-05-10',
    ledeSuffix: '.',

    // 1. Agreement
    s1H: '1. 계약',
    s1p1Pre: '본 이용약관(이하 "약관")은 다음 당사자 간에 체결되는 구속력 있는 계약입니다:',
    s1p1Strong: ' RunHQ Solutions Inc.',
    s1p1Post: ' — 캐나다 브리티시컬럼비아주 법률에 따라 설립된 법인(이하 "RunHQ", "당사", "우리" 또는 "저희") — 그리고 본 약관에 동의하는 개인 또는 법인(이하 "귀하" 또는 "고객"). 계정을 생성하거나 서비스에 접근하거나 서비스를 이용함으로써 귀하는 본 약관에 구속되는 데 동의합니다. 동의하지 않는 경우 서비스를 이용하지 마십시오.',
    s1p2: '귀하가 회사 또는 기타 조직을 대신하여 본 약관을 체결하는 경우, 귀하는 해당 조직을 구속할 권한이 있음을 진술하며, "귀하"는 해당 조직을 의미합니다. 별도로 서명된 마스터 서비스 계약이 있는 경우, 상충하는 범위 내에서 본 약관에 우선합니다.',

    // 2. Definitions
    s2H: '2. 정의',
    li2_1Label: '서비스',
    li2_1Body: ' — RunHQ 플랫폼, 웹사이트, API 및 관련 제품과 문서를 의미합니다.',
    li2_2Label: '고객 콘텐츠',
    li2_2Body: ' — 귀하가 서비스에 제출하는 할 일 항목, 코드, 댓글, 첨부 파일, 프롬프트, 에이전트 입력 및 출력, 기타 모든 데이터를 의미합니다.',
    li2_3Label: '승인된 사용자',
    li2_3Body: ' — 귀하의 계정을 통해 서비스를 이용하도록 귀하가 권한을 부여한 직원, 계약자 또는 기타 개인을 의미합니다.',
    li2_4Label: '구독',
    li2_4Body: ' — 귀하가 선택한 요금제 및 이에 따른 권한을 의미합니다.',
    li2_5Label: '주문',
    li2_5Body: ' — 본 약관을 참조하는 제품 내 결제 또는 서명된 주문서를 의미합니다.',

    // 3. Eligibility
    s3H: '3. 이용 자격',
    s3p1: '귀하는 만 18세 이상이어야 하고, 관련 법률에 따라 구속력 있는 계약을 체결할 능력이 있어야 하며, 캐나다 또는 기타 관련 관할권의 법률에 따라 서비스 수령이 금지되지 않아야 합니다. 본 서비스는 비즈니스 및 전문적 용도로 제공됩니다.',

    // 4. Accounts and security
    s4H: '4. 계정 및 보안',
    li4_1: '귀하는 승인된 사용자의 행위를 포함하여 귀하의 계정에서 발생하는 활동에 대해 책임을 집니다.',
    li4_2: '정확하고 최신의 등록 및 결제 정보를 제공하고 이를 최신 상태로 유지하십시오.',
    li4_3: '자격 증명을 안전하게 보관하십시오. 여러 사람이 하나의 계정 로그인을 공유하지 말고, 추가 승인된 사용자 좌석을 제공하십시오.',
    li4_4Pre: '무단 접근이 의심되는 경우 즉시 다음으로 알려주십시오: ',
    li4_4Suffix: '.',

    // 5. The Services
    s5H: '5. 서비스',
    s5p1: '당사는 본 약관, 당사의 문서 및 귀하의 구독 권한에 따라 구독 기간 동안 서비스에 접근하고 이를 이용할 수 있는 제한적이고 비독점적이며 양도 불가능하고 철회 가능한 권리를 귀하에게 부여합니다. 당사는 시간이 지남에 따라 기능을 추가, 수정 또는 제거할 수 있으며, 핵심 기능을 실질적으로 축소하는 변경 전에는 합리적인 통지를 제공합니다.',

    // 6. Subscriptions, fees, and billing
    s6H: '6. 구독, 요금 및 청구',
    li6_1Label: '요금제.',
    li6_1Body: ' 유료 요금제는 월간 또는 연간 단위로 선불 청구됩니다. 플랫폼 요금, 좌석당 가격 및 포함된 크레딧을 포함한 요금제 세부 사항은 결제 시 표시됩니다.',
    li6_2Label: '에이전트 크레딧.',
    li6_2Body: ' 에이전트 실행은 당사가 공시하는 요율로 크레딧을 소모합니다. 크레딧은 각 청구 주기 시작 시 갱신되며, 귀하의 요금제에 명시된 경우를 제외하고는 이월되지 않습니다.',
    li6_3Label: '초과 사용.',
    li6_3Body: ' 초과 사용이 허용되는 경우, 공시된 요율로 후불 청구됩니다.',
    li6_4Label: '세금.',
    li6_4Body: ' 가격은 세금이 포함되지 않은 금액입니다. 당사의 소득에 기반한 세금을 제외한 모든 판매세, 사용세, 부가가치세, 원천징수세 또는 유사한 세금은 귀하의 책임입니다.',
    li6_5Label: '결제.',
    li6_5Body: ' 귀하는 당사 및 당사의 결제 처리 업체가 귀하가 선택한 결제 수단에 정기적으로 청구하는 것을 승인합니다. 결제 실패 시 서면 통지 후 서비스가 중단될 수 있습니다.',
    li6_6Label: '환불.',
    li6_6Body: ' 요금은 법률에서 요구하거나 당사가 서면으로 명시적으로 동의한 경우를 제외하고는 환불되지 않습니다.',
    li6_7Label: '가격 변경.',
    li6_7Body: ' 당사는 최소 30일 전에 통지하여 다음 갱신 기간부터 가격을 변경할 수 있습니다.',

    // 7. Trials and credits
    s7H: '7. 체험판 및 크레딧',
    s7p1: '당사는 무료 체험판, 평가 계정 또는 프로모션 크레딧을 제공할 수 있습니다. 이는 "있는 그대로" 제공되며, 범위 또는 기간이 제한될 수 있고, 언제든지 변경되거나 종료될 수 있습니다. 체험판 종료 시, 체험판 만료 전에 취소하지 않는 한 귀하의 계정은 유료 요금제로 전환됩니다.',

    // 8. Cancellation and termination
    s8H: '8. 취소 및 해지',
    li8_1Pre: '귀하는 언제든지 ',
    li8_1Em: '설정 → 결제',
    li8_1Post: '에서 구독을 취소할 수 있습니다. 취소는 현재 결제 기간 종료 시 발효되며, 그때까지 접근 권한이 유지됩니다.',
    li8_2: '당사는 본 약관의 중대한 위반, 통지 후 미납 또는 법률상 요구되는 경우 서비스를 중단하거나 해지할 수 있습니다. 당사는 사전에 귀하에게 통지하기 위해 합리적인 노력을 기울입니다.',
    li8_3: '해지 시 귀하의 서비스 이용 권리는 종료됩니다. 당사는 해지 후 30일 동안 고객 콘텐츠를 내보낼 수 있도록 제공하며, 그 후에는 개인정보처리방침에 따라 삭제할 수 있습니다.',
    li8_4: '성격상 해지 후에도 존속해야 하는 조항 — 지식재산권, 기밀 유지, 면책, 책임 제한, 면책 및 보상, 준거법, 분쟁 해결 등 — 은 존속합니다.',

    // 9. Customer Content
    s9H: '9. 고객 콘텐츠',
    s9p1: '귀하는 고객 콘텐츠에 대한 모든 권리, 권원 및 이익을 보유합니다. 귀하는 당사가 귀하를 위해 서비스를 제공하고 개선하는 데 필요한 범위에서 — 귀하가 AI 제공업체를 호출할 때 프롬프트와 컨텍스트를 전송하는 것을 포함하여 — 고객 콘텐츠를 호스팅, 복제, 전송, 표시 및 처리할 수 있는 전 세계적, 비독점적, 무료 라이선스를 당사에 부여합니다. 귀하는 본 라이선스를 부여하는 데 필요한 권리를 보유하고 있으며, 고객 콘텐츠가 제3자의 권리를 침해하거나 관련 법률을 위반하지 않음을 진술합니다.',

    // 10. Acceptable use
    s10H: '10. 허용되는 이용',
    s10p1: '귀하는 다음을 행하지 않을 것이며, 어떤 승인된 사용자도 다음을 행하도록 허용하지 않기로 동의합니다:',
    li10_1: '경쟁 제품 또는 모델을 구축, 학습, 평가 또는 벤치마킹하기 위해 서비스를 사용하는 행위;',
    li10_2: '관련 법률이 명시적으로 허용하고 당사가 계약상 금지할 수 없는 제한된 범위를 제외하고, 리버스 엔지니어링, 디컴파일 또는 소스 코드를 도출하려는 시도;',
    li10_3: '악성코드, 스팸 또는 불법적이거나 침해적이거나 명예 훼손적이거나 괴롭히거나 혐오적인 콘텐츠를 전송하는 행위;',
    li10_4: '서면 승인 없이 서비스의 취약점을 조사, 스캔 또는 테스트하는 행위;',
    li10_5: '서비스의 무결성 또는 성능을 방해하거나 중단시키는 행위;',
    li10_6: '수출 통제 및 제재 법률을 포함하여 제3자의 권리 또는 관련 법률을 위반하기 위해 서비스를 사용하는 행위.',
    s10p2: '당사는 위반이 의심되는 경우 접근을 중단할 수 있으며, 그러한 경우 귀하에게 통지합니다.',

    // 11. Coding agents and generated output
    s11H: '11. 코딩 에이전트 및 생성된 출력',
    s11p1Pre: '본 서비스는 귀하를 대신하여 AI 코딩 에이전트(예: Anthropic Claude 또는 OpenAI Codex)를 조율합니다. AI 출력은 확률적입니다: 부정확하거나 안전하지 않거나 귀하의 목적에 부적합할 수 있습니다. ',
    s11p1Strong: '귀하는 에이전트가 생성한 코드 또는 기타 산출물을 병합, 배포하거나 신뢰하기 전에 이를 검토, 테스트 및 검증할 단독 책임이 있습니다.',
    s11p2: '당사는 에이전트 출력이 독창적이거나 비침해적이거나 특정 목적에 적합함을 보증하지 않습니다. 기반 AI 제공업체의 약관이 특정 약속을 전달하거나 특정 권리를 제한하도록 요구하는 경우, 해당 약관은 참조로 통합되며 요청 시 제공됩니다.',

    // 12. Third-party services
    s12H: '12. 제3자 서비스',
    s12p1: '본 서비스는 제3자 제품(예: GitHub, Linear, Slack, Intercom, 신원 제공업체 및 AI 제공업체)과 통합될 수 있습니다. 귀하의 해당 제품 이용은 해당 약관의 적용을 받습니다. 당사는 제3자 제품에 대해 책임지지 않으며, 그 지속적인 가용성을 보장하지 않습니다.',

    // 13. Intellectual property
    s13H: '13. 지식재산권',
    s13p1: '당사 및 당사의 라이선스 제공자는 소프트웨어, 디자인, 상표 및 문서를 포함한 서비스에 대한 모든 권리, 권원 및 이익을 보유합니다. 본 약관에 명시적으로 기재된 경우를 제외하고는 어떠한 권리도 부여되지 않습니다. "RunHQ" 명칭과 로고는 RunHQ Solutions Inc.의 상표이며, 허용된 설명적 사용을 제외하고는 당사의 사전 서면 허가 없이 사용할 수 없습니다.',

    // 14. Feedback
    s14H: '14. 피드백',
    s14p1: '귀하가 당사에 서비스에 관한 제안이나 피드백을 제공하는 경우, 귀하는 당사에 제한 없이 이를 사용할 수 있는 영구적, 철회 불가능, 무료, 전 세계적 라이선스를 부여합니다. 당사는 어떠한 피드백에 따라 조치를 취하거나 이를 기밀로 유지할 의무가 없습니다.',

    // 15. Confidentiality
    s15H: '15. 기밀 유지',
    s15p1: '각 당사자는 상대방의 비공개 정보(이하 "기밀 정보")를 수령할 수 있습니다. 수령 당사자는 동등한 중요도를 가진 자신의 기밀 정보를 보호하는 데 사용하는 것과 동일한 수준의 주의(어떠한 경우에도 합리적인 주의 이상)를 기울이며, 기밀 정보를 본 약관에 따른 이행을 위해서만 사용하고, 유사한 의무를 부담하는 대리인을 제외하고는 공개하지 않습니다. 기밀 정보에는 공개되었거나 공개되는 정보, 공개 전에 합법적으로 알려진 정보, 기밀 정보를 사용하지 않고 독립적으로 개발된 정보, 또는 제한 없이 제3자로부터 정당하게 입수한 정보는 포함되지 않습니다.',

    // 16. Privacy and data protection
    s16H: '16. 개인정보 및 데이터 보호',
    s16p1Pre: '당사의 개인정보 처리는 당사의 ',
    s16p1Link: '개인정보처리방침',
    s16p1Post: '에 설명되어 있습니다. GDPR, 영국 GDPR 또는 유사한 법률의 적용을 받는 개인정보를 포함하는 고객 콘텐츠의 경우, 당사의 데이터 처리 부속서(요청 시 제공)가 참조로 본 약관에 통합됩니다.',

    // 17. Disclaimers
    s17H: '17. 면책',
    s17p1Strong: '본 서비스는 "있는 그대로" 그리고 "이용 가능한 상태로" 제공됩니다.',
    s17p1Post: ' 관련 법률이 허용하는 최대 범위 내에서, RunHQ는 명시적, 묵시적, 법정 또는 기타 모든 보증을 부인하며, 여기에는 상품성, 특정 목적 적합성, 권원, 비침해 보증 및 거래 과정이나 거래 관행에서 발생하는 모든 보증이 포함됩니다. 당사는 서비스가 중단되지 않거나 오류가 없거나 안전하거나 유해한 구성 요소가 없거나 결함이 시정될 것임을 보증하지 않습니다.',

    // 18. Indemnification
    s18H: '18. 면책 및 보상',
    s18p1: '귀하는 (a) 고객 콘텐츠, (b) 귀하 또는 귀하의 승인된 사용자의 본 약관 또는 관련 법률을 위반한 서비스 이용, 또는 (c) 귀하의 에이전트 생성 출력 이용에서 발생하거나 이와 관련된 제3자 클레임으로부터 RunHQ와 그 임원, 이사, 직원 및 대리인을 방어, 면책 및 보호합니다. 당사는 그러한 클레임을 즉시 귀하에게 통지하고, 방어 및 합의에 대한 단독 통제권을 귀하에게 부여하며(당사의 인정 또는 지불을 요구하지 않는 합의에 한함), 합리적인 협조를 제공합니다.',

    // 19. Limitation of liability
    s19H: '19. 책임 제한',
    s19p1Pre: '관련 법률이 허용하는 최대 범위 내에서: (a) ',
    s19p1Strong1: '어느 당사자도 간접적, 부수적, 특별, 결과적, 징벌적 또는 처벌적 손해',
    s19p1Mid: ', 또는 일실 이익, 수익, 데이터, 영업권 또는 영업 중단에 대해 책임지지 않으며, 그 가능성을 고지받은 경우에도 마찬가지입니다; 그리고 (b) ',
    s19p1Strong2: '본 약관 또는 서비스에서 발생하거나 이와 관련된 클레임에 대한 각 당사자의 총 책임은 클레임을 야기한 사건 직전 12개월 동안 귀하가 서비스에 대해 당사에 지불한 요금으로 제한됩니다.',
    s19p2: '이러한 제한은 다음에 적용되지 않습니다: (i) 요금 지불 의무, (ii) 제10조(허용되는 이용) 또는 제18조(면책 및 보상)에 따른 의무, (iii) 어느 당사자의 중대한 과실, 고의적 위법 행위 또는 사기, 또는 (iv) 관련 법률에 따라 제한될 수 없는 책임.',

    // 20. Governing law and venue
    s20H: '20. 준거법 및 재판 관할',
    s20p1: '본 약관은 법률 충돌 원칙을 고려하지 않고 브리티시컬럼비아주 법률 및 브리티시컬럼비아주에서 적용 가능한 캐나다 연방 법률에 의해 규율됩니다. 국제물품매매계약에 관한 유엔 협약은 적용되지 않습니다. 당사자는 중재의 대상이 아닌 모든 분쟁에 대해 캐나다 브리티시컬럼비아주 밴쿠버 법원의 전속 관할권에 따릅니다.',

    // 21. Dispute resolution
    s21H: '21. 분쟁 해결',
    s21p1: '클레임 제기 전에, 당사자는 서면 통지 후 최소 30일 동안 분쟁을 비공식적으로 해결하기 위해 성실히 노력합니다. 비공식적으로 해결될 수 없는 분쟁은 개별적으로 해결됩니다 — 집단 소송, 집단 중재 및 대표 소송은 법률이 허용하는 최대 범위 내에서 허용되지 않습니다. 귀하가 본 조항을 무효화하는 법률이 적용되는 관할권의 소비자인 경우, 본 조항은 귀하에게 적용되지 않습니다.',

    // 22. Force majeure
    s22H: '22. 불가항력',
    s22p1: '어느 당사자도 천재지변, 전쟁, 시민 소요, 노동 쟁의, 인터넷 또는 유틸리티 중단, 인프라 공격, 팬데믹 또는 정부 조치를 포함하여 합리적인 통제를 벗어난 사건으로 인한 실패 또는 지연에 대해 책임지지 않습니다. 영향을 받는 의무는 해당 사건의 기간 동안 중단되며; 결제 의무는 일상적인 고객 측 중단에 대해서는 중단되지 않습니다.',

    // 23. Export and sanctions
    s23H: '23. 수출 및 제재',
    s23p1: '귀하는 캐나다, 미국, 영국 및 유럽 연합의 법률을 포함하여 모든 관련 수출 통제 및 제재 법률을 준수합니다. 귀하는 귀하와 귀하의 승인된 사용자가 서비스 이용을 금지하는 제재의 대상이 아님을 진술합니다.',

    // 24. Assignment
    s24H: '24. 양도',
    s24p1: '귀하는 양수인이 RunHQ의 경쟁자가 아닌 경우에 한하여 계열사 또는 합병, 인수 또는 자산 전부의 양도와 관련된 경우를 제외하고는 당사의 사전 서면 동의 없이 본 약관을 양도할 수 없습니다. 당사는 기업 거래와 관련하여 본 약관을 양도할 수 있습니다. 허용되지 않는 양도는 무효입니다.',

    // 25. Notices
    s25H: '25. 통지',
    s25p1Pre: 'RunHQ에 대한 통지는 다음으로 보내야 합니다: ',
    s25p1Post: '. 귀하에 대한 통지는 귀하의 계정에 등록된 이메일 주소로 또는 제품 내 알림을 통해 이루어질 수 있으며, 발송된 날에 수신된 것으로 간주됩니다.',

    // 26. Severability and waiver
    s26H: '26. 분리 가능성 및 권리 포기',
    s26p1: '본 약관의 어떤 조항이 집행 불가능한 것으로 판단되는 경우, 나머지 조항은 효력을 유지하며, 집행 불가능한 조항은 집행 가능하도록 최소한의 범위에서 수정됩니다. 조항을 집행하지 않는 것은 권리 포기를 의미하지 않습니다.',

    // 27. Entire agreement
    s27H: '27. 완전 합의',
    s27p1: '본 약관(여기에 언급된 주문서, 개인정보처리방침 및 DPA와 함께)은 서비스에 관한 당사자 간의 완전한 합의를 구성하며, 그 주제에 관한 이전의 모든 합의 및 양해를 대체합니다. 모든 구매 주문서의 사전 인쇄된 약관은 거부됩니다.',

    // 28. Changes to these Terms
    s28H: '28. 본 약관의 변경',
    s28p1: '당사는 본 약관을 수시로 업데이트할 수 있습니다. 상단의 "발효일"은 최신 개정일을 나타냅니다. 중대한 변경의 경우, 당사는 이메일 또는 제품 내를 통해 합리적인 사전 통지를 제공합니다. 변경 사항에 동의하지 않는 경우, 귀하의 유일한 구제책은 변경 사항이 발효되기 전에 서비스 이용을 중단하고 구독을 취소하는 것입니다.',

    // 29. Contact
    s29H: '29. 연락처',
    s29p1Strong: 'RunHQ Solutions Inc.',
    s29p1Post: ', 캐나다 브리티시컬럼비아주 밴쿠버.',
    s29p2Pre: '본 약관에 관한 문의: ',
    s29p2Suffix: '.',

    disclaimer: '본 약관은 당사의 표준 상업적 관계를 설명하며 법률 자문이 아닙니다. 구체적인 문의는 당사에 직접 연락해 주십시오.',
  },
} as const;

export default function TermsPage() {
  const t = useT(TERMS_T);
  return (
    <div className="rhp-root rhl-root">
      <style>{LEGAL_STYLES}</style>
      <Navbar />

      <section className="rhp-hero">
        <div className="rhp-hero-eyebrow">{t.eyebrow}</div>
        <h1 className="rhp-hero-h1">{t.h1}</h1>
        <p className="rhp-hero-lede">
          {t.ledePre}{t.ledeDate}{t.ledeSuffix}
        </p>
      </section>

      <article className="rhl-doc">
        <section className="rhl-sec">
          <h2>{t.s1H}</h2>
          <p>
            {t.s1p1Pre}<strong>{t.s1p1Strong}</strong>{t.s1p1Post}
          </p>
          <p>{t.s1p2}</p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s2H}</h2>
          <ul>
            <li><strong>{t.li2_1Label}</strong>{t.li2_1Body}</li>
            <li><strong>{t.li2_2Label}</strong>{t.li2_2Body}</li>
            <li><strong>{t.li2_3Label}</strong>{t.li2_3Body}</li>
            <li><strong>{t.li2_4Label}</strong>{t.li2_4Body}</li>
            <li><strong>{t.li2_5Label}</strong>{t.li2_5Body}</li>
          </ul>
        </section>

        <section className="rhl-sec">
          <h2>{t.s3H}</h2>
          <p>{t.s3p1}</p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s4H}</h2>
          <ul>
            <li>{t.li4_1}</li>
            <li>{t.li4_2}</li>
            <li>{t.li4_3}</li>
            <li>{t.li4_4Pre}<a className="rhl-link" href="mailto:admin@runhq.io">admin@runhq.io</a>{t.li4_4Suffix}</li>
          </ul>
        </section>

        <section className="rhl-sec">
          <h2>{t.s5H}</h2>
          <p>{t.s5p1}</p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s6H}</h2>
          <ul>
            <li><strong>{t.li6_1Label}</strong>{t.li6_1Body}</li>
            <li><strong>{t.li6_2Label}</strong>{t.li6_2Body}</li>
            <li><strong>{t.li6_3Label}</strong>{t.li6_3Body}</li>
            <li><strong>{t.li6_4Label}</strong>{t.li6_4Body}</li>
            <li><strong>{t.li6_5Label}</strong>{t.li6_5Body}</li>
            <li><strong>{t.li6_6Label}</strong>{t.li6_6Body}</li>
            <li><strong>{t.li6_7Label}</strong>{t.li6_7Body}</li>
          </ul>
        </section>

        <section className="rhl-sec">
          <h2>{t.s7H}</h2>
          <p>{t.s7p1}</p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s8H}</h2>
          <ul>
            <li>{t.li8_1Pre}<em>{t.li8_1Em}</em>{t.li8_1Post}</li>
            <li>{t.li8_2}</li>
            <li>{t.li8_3}</li>
            <li>{t.li8_4}</li>
          </ul>
        </section>

        <section className="rhl-sec">
          <h2>{t.s9H}</h2>
          <p>{t.s9p1}</p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s10H}</h2>
          <p>{t.s10p1}</p>
          <ul>
            <li>{t.li10_1}</li>
            <li>{t.li10_2}</li>
            <li>{t.li10_3}</li>
            <li>{t.li10_4}</li>
            <li>{t.li10_5}</li>
            <li>{t.li10_6}</li>
          </ul>
          <p>{t.s10p2}</p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s11H}</h2>
          <p>
            {t.s11p1Pre}<strong>{t.s11p1Strong}</strong>
          </p>
          <p>{t.s11p2}</p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s12H}</h2>
          <p>{t.s12p1}</p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s13H}</h2>
          <p>{t.s13p1}</p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s14H}</h2>
          <p>{t.s14p1}</p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s15H}</h2>
          <p>{t.s15p1}</p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s16H}</h2>
          <p>
            {t.s16p1Pre}<Link className="rhl-link" to="/privacy">{t.s16p1Link}</Link>{t.s16p1Post}
          </p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s17H}</h2>
          <p>
            <strong>{t.s17p1Strong}</strong>{t.s17p1Post}
          </p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s18H}</h2>
          <p>{t.s18p1}</p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s19H}</h2>
          <p>
            {t.s19p1Pre}<strong>{t.s19p1Strong1}</strong>{t.s19p1Mid}<strong>{t.s19p1Strong2}</strong>
          </p>
          <p>{t.s19p2}</p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s20H}</h2>
          <p>{t.s20p1}</p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s21H}</h2>
          <p>{t.s21p1}</p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s22H}</h2>
          <p>{t.s22p1}</p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s23H}</h2>
          <p>{t.s23p1}</p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s24H}</h2>
          <p>{t.s24p1}</p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s25H}</h2>
          <p>
            {t.s25p1Pre}<a className="rhl-link" href="mailto:admin@runhq.io">admin@runhq.io</a>{t.s25p1Post}
          </p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s26H}</h2>
          <p>{t.s26p1}</p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s27H}</h2>
          <p>{t.s27p1}</p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s28H}</h2>
          <p>{t.s28p1}</p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s29H}</h2>
          <p>
            <strong>{t.s29p1Strong}</strong>{t.s29p1Post}
          </p>
          <p>
            {t.s29p2Pre}<a className="rhl-link" href="mailto:admin@runhq.io">admin@runhq.io</a>{t.s29p2Suffix}
          </p>
        </section>

        <p className="rhl-disclaimer">{t.disclaimer}</p>
      </article>

      <Footer />
    </div>
  );
}
