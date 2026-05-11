import { Navbar, Footer } from '../components/chrome';
import { useT } from '../i18n/context';

const PRIVACY_T = {
  en: {
    eyebrow: 'Legal · Privacy policy',
    h1: 'Privacy policy.',
    ledePre: 'How RunHQ Solutions Inc. collects, uses, shares, and protects information. ',
    effective: 'Effective 2026-05-10.',

    s1H: '1. Introduction',
    s1p1Pre: 'RunHQ Solutions Inc. (“RunHQ,” “we,” “us,” or “our”) operates the RunHQ platform — a hosted service that lets teams capture product feedback, run AI coding agents, review proposed code changes, and ship software. This Privacy Policy describes the categories of information we collect when you use the platform, our website at',
    s1p1Em: ' runhq.io',
    s1p1Post: ', and related services (together, the “Services”), how we use and share that information, and the rights and choices you have.',
    s1p2: 'This Policy applies to information collected through the Services. It does not apply to data your organization processes through self-hosted tools we do not operate, or to third-party services you connect to the Services (for example, GitHub, Linear, Slack, or external AI providers), which are governed by their own policies.',

    s2H: '2. Roles: controller and processor',
    s2p1Pre: 'For account-level information (your name, email, billing details, support interactions, and platform telemetry tied to your account), RunHQ acts as a',
    s2p1Strong1: ' data controller',
    s2p1Mid: '. For workspace content your organization submits to the Services — todos, comments, code, attachments, agent runs, and similar — we act as a ',
    s2p1Strong2: 'processor',
    s2p1Post: ' on behalf of the customer organization (typically your employer), which is the controller of that content.',

    s3H: '3. Information we collect',
    s3aH: 'a. Information you provide',
    s3aLi1Label: 'Account & profile:',
    s3aLi1Body: ' name, work email, organization, job role, and password (hashed). If you sign in with a third-party identity provider, we receive the identifying data that provider releases to us.',
    s3aLi2Label: 'Workspace content:',
    s3aLi2Body: ' todos, projects, comments, attachments, codebases connected through integrations, agent run inputs and outputs, review decisions, and any other content you create or upload through the Services.',
    s3aLi3Label: 'Billing details:',
    s3aLi3Body: ' billing contact, address, plan selection, tax identifiers where required, and payment metadata. Card numbers are entered directly with our payment processor and are not stored on our servers.',
    s3aLi4Label: 'Communications:',
    s3aLi4Body: ' support tickets, in-product chats, survey responses, and emails you send us.',
    s3bH: 'b. Information we collect automatically',
    s3bLi1Label: 'Device & connection data:',
    s3bLi1Body: ' IP address, user-agent, device type, operating system, browser, language, and approximate location derived from IP.',
    s3bLi2Label: 'Product telemetry:',
    s3bLi2Body: ' pages and features used, clicks, agent run metadata (duration, tokens, status), error traces, and similar usage events.',
    s3bLi3Label: 'Cookies & similar technologies:',
    s3bLi3Body: ' see Section 11.',
    s3cH: 'c. Information from third parties',
    s3cLi1Label: 'Identity providers',
    s3cLi1Body: ' (e.g., Google, GitHub, your SSO) — basic profile and authentication tokens.',
    s3cLi2Label: 'Connected integrations',
    s3cLi2Body: ' (e.g., GitHub, Linear, Slack, Intercom) — only the data you authorize the integration to share with the Services.',
    s3cLi3Label: 'Billing & fraud-prevention vendors',
    s3cLi3Body: ' — payment confirmations, chargeback notices, risk signals.',

    s4H: '4. How we use information',
    s4Li1Label: 'Operate the Services:',
    s4Li1Body: ' authenticate users, route todos, execute agent runs, deliver notifications, persist workspace content.',
    s4Li2Label: 'Bill and account:',
    s4Li2Body: ' process subscriptions and invoices, issue receipts, manage seat counts and credit balances.',
    s4Li3Label: 'Support:',
    s4Li3Body: ' respond to questions, troubleshoot incidents, communicate about your account.',
    s4Li4Label: 'Security:',
    s4Li4Body: ' detect and prevent abuse, fraud, and unauthorized access; investigate incidents; enforce our Terms.',
    s4Li5Label: 'Improve and develop:',
    s4Li5Body: ' measure feature adoption, debug, and design product changes — using aggregated and anonymized data wherever practical.',
    s4Li6Label: 'Legal compliance:',
    s4Li6Body: ' meet tax, accounting, audit, and legal-process obligations.',
    s4pPre: 'We do ',
    s4pStrong: 'not',
    s4pPost: ' use customer workspace content to train our own foundation models, and we do not sell personal information.',

    s5H: '5. Legal bases (EEA / UK)',
    s5p: 'If you are in the European Economic Area or United Kingdom, we rely on:',
    s5Li1Label: 'Contract',
    s5Li1Body: ' — to provide the Services to you under our Terms.',
    s5Li2Label: 'Legitimate interests',
    s5Li2Body: ' — to secure, maintain, and improve the Services, prevent abuse, and run our business, balanced against your rights.',
    s5Li3Label: 'Consent',
    s5Li3Body: ' — for non-essential cookies and any optional communications, withdrawable at any time.',
    s5Li4Label: 'Legal obligation',
    s5Li4Body: ' — to comply with applicable law and lawful requests.',

    s6H: '6. AI and coding agents',
    s6p1: "When you trigger an agent run, the inputs you select (prompt, related context, relevant files) are transmitted to the AI provider you have chosen — for example, Anthropic (Claude) or OpenAI (Codex). Those providers process the data under their own terms and privacy commitments, which we have reviewed before integrating. We pass along your organization's no-training preferences where the provider supports them.",
    s6p2: 'Agent outputs are returned to your workspace and treated as your customer content. We log run metadata (duration, status, token counts) to support billing, reliability, and audit, and we retain inputs and outputs for the period defined in Section 9.',

    s7H: '7. How we share information',
    s7pIntro: 'We share information only with the following categories of recipients:',
    s7Li1Label: 'Subprocessors',
    s7Li1Body: ' — vetted vendors who process data on our behalf to operate the Services. Categories include cloud infrastructure (compute, storage, CDN), AI providers when invoked by your runs, error monitoring and observability, customer support, transactional email, analytics, and payment processing. A current subprocessor list is available on request.',
    s7Li2Label: 'Within your organization',
    s7Li2Body: ' — workspace content is visible to authorized members of your workspace per the access controls your administrators configure.',
    s7Li3Label: 'Connected integrations',
    s7Li3Body: ' — only the data you direct us to send (for example, opening an issue in your linked GitHub repo).',
    s7Li4Label: 'Professional advisers',
    s7Li4Body: ' — auditors, lawyers, and accountants under duties of confidentiality.',
    s7Li5Label: 'Corporate transactions',
    s7Li5Body: ' — a successor entity in a merger, acquisition, financing, or sale of assets, subject to commitments at least as protective as this Policy.',
    s7Li6Label: 'Compliance and safety',
    s7Li6Body: ' — law enforcement, regulators, or other parties when we believe disclosure is required by law or necessary to protect rights, property, or safety. We push back on overbroad requests.',
    s7pOutro: 'We do not sell or rent personal information, and we do not share it for cross-context behavioral advertising.',

    s8H: '8. International transfers',
    s8p: 'We are based in Canada and our primary infrastructure runs in North American regions. If you access the Services from another country, your information will be transferred to and processed in jurisdictions whose laws may differ from those of your home country. Where required, we use Standard Contractual Clauses, the UK IDTA or equivalent transfer mechanisms with our subprocessors.',

    s9H: '9. Data retention',
    s9Li1Label: 'Account data',
    s9Li1Body: ' — retained for the life of the account and a short period afterward to handle billing reconciliation, audit, and dispute resolution.',
    s9Li2Label: 'Workspace content',
    s9Li2Body: ' — retained while the workspace is active. After deletion, content is removed from primary systems within 30 days; encrypted backups roll off within 90 days.',
    s9Li3Label: 'Telemetry & logs',
    s9Li3Body: ' — retained on a rolling 13-month window, except where a security investigation or legal hold requires longer retention.',
    s9Li4Label: 'Billing records',
    s9Li4Body: ' — retained for as long as required by tax and accounting law (typically 7 years).',
    s9pOutro: 'You can request earlier deletion of your personal data by contacting us; we will honor the request unless we have a legal basis to retain.',

    s10H: '10. Security',
    s10p: 'We use administrative, technical, and physical safeguards designed to protect information against unauthorized access, disclosure, alteration, and destruction — including encryption in transit and at rest, role-based access controls, least-privilege production access, audit logging, vulnerability management, and secure development practices. No system is impenetrable; if we ever experience a breach affecting your information, we will notify you in line with applicable law.',

    s11H: '11. Cookies and similar technologies',
    s11pIntro: 'We use a small number of cookies and similar technologies:',
    s11Li1Label: 'Strictly necessary',
    s11Li1Body: ' — sign-in sessions, security tokens, basic load balancing.',
    s11Li2Label: 'Functional',
    s11Li2Body: ' — remember your preferences (theme, recent workspace).',
    s11Li3Label: 'Analytics',
    s11Li3Body: ' — aggregate usage measurement to improve the product.',
    s11pOutro: 'You can disable non-essential cookies via your browser. Disabling strictly necessary cookies will prevent core functionality from working. We honor Global Privacy Control signals where applicable.',

    s12H: '12. Your rights and choices',
    s12p1Pre: 'Depending on where you live, you may have the right to access, correct, port, delete, or restrict the processing of your personal data, to object to certain processing, and to withdraw consent. California residents have specific rights under the CCPA/CPRA, including the right to know, delete, correct, and opt out of the sale or sharing of personal information (we do neither). To exercise your rights, email ',
    s12p1Post: '. We will verify your request and respond within the period required by law. You may also lodge a complaint with your local data-protection authority.',
    s12p2: 'If your data is processed at the direction of an organization that uses RunHQ (your employer, for instance), we will refer your request to that organization and assist them in responding.',

    s13H: "13. Children's privacy",
    s13p: 'The Services are intended for business users and are not directed at children under 16. We do not knowingly collect personal information from children. If you believe a child has provided us information, please contact us so we can delete it.',

    s14H: '14. Third-party links',
    s14p: 'The Services may link to third-party sites or invoke third-party tools. We are not responsible for the privacy practices of those third parties; review their policies before sharing information with them.',

    s15H: '15. Changes to this Policy',
    s15p: 'We may update this Policy from time to time. The “Effective” date at the top indicates the latest revision. For material changes, we will give notice by email or in-product before the change takes effect. Continued use of the Services after the effective date indicates acceptance of the updated Policy.',

    s16H: '16. Contact us',
    s16p1Strong: 'RunHQ Solutions Inc.',
    s16p1Post: ', Vancouver, British Columbia, Canada.',
    s16p2Pre: 'Privacy and data-protection inquiries: ',
    s16p2Post: '.',

    disclaimer: 'This Policy is provided for transparency about our practices and is not legal advice. For specific questions about how it applies to you, contact us directly.',
  },
  ko: {
    eyebrow: '법적 고지 · 개인정보 처리방침',
    h1: '개인정보 처리방침.',
    ledePre: 'RunHQ Solutions Inc.가 정보를 수집, 이용, 공유 및 보호하는 방법에 관한 안내입니다. ',
    effective: '시행일: 2026-05-10.',

    s1H: '1. 서문',
    s1p1Pre: 'RunHQ Solutions Inc.(이하 "RunHQ," "당사," "우리")는 팀이 제품 피드백을 수집하고, AI 코딩 agent를 실행하며, 제안된 코드 변경을 검토하고, 소프트웨어를 배포할 수 있도록 하는 호스팅 서비스인 RunHQ 플랫폼을 운영합니다. 본 개인정보 처리방침은 귀하가 본 플랫폼, 당사의 웹사이트',
    s1p1Em: ' runhq.io',
    s1p1Post: ' 및 관련 서비스(이하 통칭 "서비스")를 이용할 때 당사가 수집하는 정보의 범주, 그러한 정보의 이용 및 공유 방식, 그리고 귀하가 보유하는 권리와 선택 사항을 설명합니다.',
    s1p2: '본 방침은 서비스를 통해 수집되는 정보에 적용됩니다. 본 방침은 당사가 운영하지 않는 자체 호스팅 도구를 통해 귀하의 조직이 처리하는 데이터, 또는 귀하가 서비스에 연결하는 제3자 서비스(예: GitHub, Linear, Slack 또는 외부 AI 제공업체)에는 적용되지 않으며, 해당 제3자 서비스는 각각의 자체 방침에 의해 규율됩니다.',

    s2H: '2. 역할: 컨트롤러와 프로세서',
    s2p1Pre: '계정 단위 정보(귀하의 이름, 이메일, 결제 정보, 고객 지원 상호작용, 계정과 연결된 플랫폼 텔레메트리)에 대하여 RunHQ는',
    s2p1Strong1: ' 개인정보처리자(컨트롤러)',
    s2p1Mid: '로서 행위합니다. 귀하의 조직이 서비스에 제출하는 워크스페이스 콘텐츠(할 일, 댓글, 코드, 첨부파일, agent 실행 등)에 대하여 당사는 해당 콘텐츠의 컨트롤러인 고객 조직(통상 귀하의 사용자)을 대신하여 ',
    s2p1Strong2: '수탁자(프로세서)',
    s2p1Post: '로서 행위합니다.',

    s3H: '3. 수집하는 정보',
    s3aH: 'a. 귀하가 제공하는 정보',
    s3aLi1Label: '계정 및 프로필:',
    s3aLi1Body: ' 이름, 업무용 이메일, 조직, 직무, 비밀번호(해시 처리). 제3자 신원 제공업체로 로그인하는 경우, 해당 제공업체가 당사에 공개하는 식별 정보를 수신합니다.',
    s3aLi2Label: '워크스페이스 콘텐츠:',
    s3aLi2Body: ' 할 일, 프로젝트, 댓글, 첨부파일, 연동을 통해 연결된 코드베이스, agent 실행 입력 및 출력, 검토 결정, 그리고 귀하가 서비스를 통해 생성하거나 업로드하는 기타 모든 콘텐츠.',
    s3aLi3Label: '결제 정보:',
    s3aLi3Body: ' 결제 담당자, 주소, 요금제 선택, 필요 시 세금 식별 번호, 결제 메타데이터. 카드 번호는 당사의 결제 처리업체에 직접 입력되며 당사 서버에는 저장되지 않습니다.',
    s3aLi4Label: '커뮤니케이션:',
    s3aLi4Body: ' 고객 지원 티켓, 제품 내 채팅, 설문조사 응답, 귀하가 당사에 보내는 이메일.',
    s3bH: 'b. 자동으로 수집되는 정보',
    s3bLi1Label: '기기 및 접속 데이터:',
    s3bLi1Body: ' IP 주소, 사용자 agent, 기기 유형, 운영체제, 브라우저, 언어, IP에서 추정한 대략적 위치.',
    s3bLi2Label: '제품 텔레메트리:',
    s3bLi2Body: ' 이용한 페이지 및 기능, 클릭, agent 실행 메타데이터(소요 시간, 토큰, 상태), 오류 추적, 그리고 이와 유사한 이용 이벤트.',
    s3bLi3Label: '쿠키 및 유사 기술:',
    s3bLi3Body: ' 제11항을 참조하시기 바랍니다.',
    s3cH: 'c. 제3자로부터 받는 정보',
    s3cLi1Label: '신원 제공업체',
    s3cLi1Body: '(예: Google, GitHub, 귀하의 SSO) — 기본 프로필 및 인증 토큰.',
    s3cLi2Label: '연결된 연동 서비스',
    s3cLi2Body: '(예: GitHub, Linear, Slack, Intercom) — 귀하가 해당 연동 서비스에 서비스와 공유하도록 승인한 데이터에 한합니다.',
    s3cLi3Label: '결제 및 사기 방지 공급업체',
    s3cLi3Body: ' — 결제 확인, 환불 통지, 위험 신호.',

    s4H: '4. 정보 이용',
    s4Li1Label: '서비스 운영:',
    s4Li1Body: ' 사용자 인증, 할 일 라우팅, agent 실행, 알림 전송, 워크스페이스 콘텐츠 보존.',
    s4Li2Label: '청구 및 회계:',
    s4Li2Body: ' 구독 및 인보이스 처리, 영수증 발행, 좌석 수 및 크레딧 잔액 관리.',
    s4Li3Label: '고객 지원:',
    s4Li3Body: ' 문의 응답, 장애 해결, 계정 관련 안내.',
    s4Li4Label: '보안:',
    s4Li4Body: ' 남용, 사기 및 무단 접근의 탐지 및 예방, 사고 조사, 이용약관 집행.',
    s4Li5Label: '개선 및 개발:',
    s4Li5Body: ' 기능 도입률 측정, 디버깅, 제품 변경 설계 — 실현 가능한 경우 집계 및 익명화된 데이터를 사용합니다.',
    s4Li6Label: '법적 준수:',
    s4Li6Body: ' 세무, 회계, 감사 및 법적 절차 의무 이행.',
    s4pPre: '당사는 고객의 워크스페이스 콘텐츠를 당사 자체 파운데이션 모델 학습에 ',
    s4pStrong: '이용하지 않으며',
    s4pPost: ', 개인정보를 판매하지 않습니다.',

    s5H: '5. 법적 근거 (EEA / UK)',
    s5p: '귀하가 유럽경제지역(EEA) 또는 영국에 거주하는 경우, 당사는 다음을 근거로 합니다:',
    s5Li1Label: '계약',
    s5Li1Body: ' — 당사 이용약관에 따라 귀하에게 서비스를 제공하기 위함.',
    s5Li2Label: '정당한 이익',
    s5Li2Body: ' — 서비스를 보호, 유지, 개선하고 남용을 방지하며 사업을 운영하기 위함이며, 귀하의 권리와 균형을 이룹니다.',
    s5Li3Label: '동의',
    s5Li3Body: ' — 비필수 쿠키 및 모든 선택적 커뮤니케이션에 대한 근거이며, 언제든지 철회할 수 있습니다.',
    s5Li4Label: '법적 의무',
    s5Li4Body: ' — 적용 법률 및 적법한 요청을 준수하기 위함.',

    s6H: '6. AI 및 코딩 agent',
    s6p1: '귀하가 agent 실행을 트리거하면, 귀하가 선택한 입력값(프롬프트, 관련 컨텍스트, 관련 파일)이 귀하가 선택한 AI 제공업체(예: Anthropic(Claude) 또는 OpenAI(Codex))로 전송됩니다. 해당 제공업체는 당사가 연동 전에 검토한 자체 약관 및 개인정보 보호 약정에 따라 데이터를 처리합니다. 당사는 제공업체가 지원하는 경우 귀하 조직의 학습 제외(no-training) 환경설정을 함께 전달합니다.',
    s6p2: 'agent 출력값은 귀하의 워크스페이스로 반환되며 귀하의 고객 콘텐츠로 취급됩니다. 당사는 청구, 안정성, 감사 목적을 위해 실행 메타데이터(소요 시간, 상태, 토큰 수)를 기록하며, 입력값과 출력값은 제9항에서 정한 기간 동안 보존합니다.',

    s7H: '7. 정보 공유',
    s7pIntro: '당사는 다음의 수령자 범주에 한하여 정보를 공유합니다:',
    s7Li1Label: '재수탁자',
    s7Li1Body: ' — 서비스를 운영하기 위해 당사를 대신하여 데이터를 처리하는 검증된 공급업체. 범주에는 클라우드 인프라(컴퓨팅, 스토리지, CDN), 귀하의 실행 시 호출되는 AI 제공업체, 오류 모니터링 및 옵저버빌리티, 고객 지원, 트랜잭션 이메일, 분석, 결제 처리가 포함됩니다. 최신 재수탁자 목록은 요청 시 제공됩니다.',
    s7Li2Label: '귀하의 조직 내부',
    s7Li2Body: ' — 워크스페이스 콘텐츠는 관리자가 구성한 접근 제어에 따라 권한이 부여된 워크스페이스 구성원에게 공개됩니다.',
    s7Li3Label: '연결된 연동 서비스',
    s7Li3Body: ' — 귀하가 전송하도록 지시한 데이터에 한합니다(예: 연결된 GitHub 리포지토리에 이슈 생성).',
    s7Li4Label: '전문 자문',
    s7Li4Body: ' — 비밀유지 의무를 부담하는 감사인, 변호사 및 회계사.',
    s7Li5Label: '기업 거래',
    s7Li5Body: ' — 합병, 인수, 자금 조달 또는 자산 매각의 승계 법인에 대하여, 본 방침과 동등 이상의 보호 약정을 조건으로 합니다.',
    s7Li6Label: '준법 및 안전',
    s7Li6Body: ' — 법률상 요구되거나 권리, 재산 또는 안전을 보호하기 위해 공개가 필요하다고 판단되는 경우의 법 집행기관, 규제기관 또는 기타 당사자. 당사는 과도하게 광범위한 요청에 대해서는 이의를 제기합니다.',
    s7pOutro: '당사는 개인정보를 판매하거나 임대하지 않으며, 교차 맥락 행동기반 광고를 위해 공유하지 않습니다.',

    s8H: '8. 국외 이전',
    s8p: '당사는 캐나다에 본사를 두고 있으며 주요 인프라는 북미 지역에서 운영됩니다. 다른 국가에서 서비스에 접속하는 경우, 귀하의 정보는 귀하의 거주국과 법률이 다를 수 있는 관할권으로 이전되어 처리됩니다. 필요한 경우 당사는 재수탁자와 표준계약조항(SCC), 영국 IDTA 또는 이에 상응하는 이전 메커니즘을 사용합니다.',

    s9H: '9. 보존 기간',
    s9Li1Label: '계정 데이터',
    s9Li1Body: ' — 계정 존속 기간 및 청구 조정, 감사, 분쟁 해결을 위해 그 이후 단기간 동안 보존됩니다.',
    s9Li2Label: '워크스페이스 콘텐츠',
    s9Li2Body: ' — 워크스페이스가 활성 상태인 동안 보존됩니다. 삭제 후에는 30일 이내에 주요 시스템에서 제거되며, 암호화된 백업은 90일 이내에 순환 삭제됩니다.',
    s9Li3Label: '텔레메트리 및 로그',
    s9Li3Body: ' — 보안 조사 또는 법적 보존 요청으로 더 긴 보존이 필요한 경우를 제외하고, 13개월의 순환 기간 동안 보존됩니다.',
    s9Li4Label: '청구 기록',
    s9Li4Body: ' — 세무 및 회계 법령에서 요구하는 기간(통상 7년) 동안 보존됩니다.',
    s9pOutro: '귀하는 당사에 연락하여 개인정보의 조기 삭제를 요청할 수 있으며, 당사가 보존할 법적 근거를 갖지 않는 한 그 요청을 이행합니다.',

    s10H: '10. 보안',
    s10p: '당사는 전송 중 및 저장 시 암호화, 역할 기반 접근 통제, 최소 권한 운영 접근, 감사 로깅, 취약점 관리, 보안 개발 관행 등을 포함하여 무단 접근, 공개, 변경 및 파기로부터 정보를 보호하도록 설계된 관리적, 기술적, 물리적 보호조치를 사용합니다. 어떤 시스템도 완벽하지 않으며, 만약 귀하의 정보에 영향을 미치는 침해가 발생하는 경우 당사는 적용 법령에 따라 귀하에게 통지합니다.',

    s11H: '11. 쿠키 및 유사 기술',
    s11pIntro: '당사는 소수의 쿠키 및 유사 기술을 사용합니다:',
    s11Li1Label: '필수 쿠키',
    s11Li1Body: ' — 로그인 세션, 보안 토큰, 기본 부하 분산.',
    s11Li2Label: '기능 쿠키',
    s11Li2Body: ' — 귀하의 환경설정(테마, 최근 워크스페이스) 기억.',
    s11Li3Label: '분석 쿠키',
    s11Li3Body: ' — 제품 개선을 위한 집계 이용 측정.',
    s11pOutro: '귀하는 브라우저를 통해 비필수 쿠키를 비활성화할 수 있습니다. 필수 쿠키를 비활성화하면 핵심 기능이 작동하지 않습니다. 당사는 해당되는 경우 Global Privacy Control 신호를 존중합니다.',

    s12H: '12. 이용자의 권리와 선택',
    s12p1Pre: '거주 지역에 따라 귀하는 개인정보에 대한 접근, 정정, 이동, 삭제 또는 처리 제한, 특정 처리에 대한 이의 제기, 동의 철회의 권리를 가질 수 있습니다. 캘리포니아 거주자는 CCPA/CPRA에 따라 개인정보의 판매 또는 공유에 대한 알 권리, 삭제권, 정정권, 거부권 등 특정 권리를 보유합니다(당사는 두 행위 모두 하지 않습니다). 권리 행사를 원하실 경우 ',
    s12p1Post: '으로 이메일을 보내주시기 바랍니다. 당사는 귀하의 요청을 확인한 후 법령이 정한 기간 내에 응답합니다. 귀하는 또한 거주 지역의 데이터 보호 감독기관에 진정을 제기할 수 있습니다.',
    s12p2: '귀하의 데이터가 RunHQ를 이용하는 조직(예: 귀하의 사용자)의 지시에 따라 처리되는 경우, 당사는 귀하의 요청을 해당 조직으로 이관하고 응답을 지원합니다.',

    s13H: '13. 아동의 개인정보',
    s13p: '본 서비스는 비즈니스 사용자를 대상으로 하며 만 16세 미만의 아동을 대상으로 하지 않습니다. 당사는 아동으로부터 개인정보를 알면서 수집하지 않습니다. 아동이 당사에 정보를 제공했다고 판단되는 경우, 삭제할 수 있도록 당사에 연락하시기 바랍니다.',

    s14H: '14. 제3자 링크',
    s14p: '본 서비스는 제3자 사이트로 연결되거나 제3자 도구를 호출할 수 있습니다. 당사는 해당 제3자의 개인정보 처리 관행에 대해 책임을 지지 않으므로, 정보를 공유하기 전에 해당 제3자의 방침을 검토하시기 바랍니다.',

    s15H: '15. 방침의 변경',
    s15p: '당사는 본 방침을 수시로 갱신할 수 있습니다. 상단의 "시행일"은 최신 개정일을 나타냅니다. 중대한 변경의 경우, 변경이 발효되기 전에 이메일 또는 제품 내 알림으로 통지합니다. 시행일 이후 서비스의 계속 이용은 갱신된 방침에 대한 동의를 의미합니다.',

    s16H: '16. 문의처',
    s16p1Strong: 'RunHQ Solutions Inc.',
    s16p1Post: ', Vancouver, British Columbia, Canada.',
    s16p2Pre: '개인정보 및 데이터 보호 관련 문의: ',
    s16p2Post: '.',

    disclaimer: '본 방침은 당사의 관행에 대한 투명성을 위해 제공되며 법률 자문이 아닙니다. 귀하에게 어떻게 적용되는지에 관한 구체적인 질문은 당사에 직접 문의하시기 바랍니다.',
  },
} as const;

export default function PrivacyPage() {
  const t = useT(PRIVACY_T);
  return (
    <div className="rhp-root rhl-root">
      <style>{LEGAL_STYLES}</style>
      <Navbar />

      <section className="rhp-hero">
        <div className="rhp-hero-eyebrow">{t.eyebrow}</div>
        <h1 className="rhp-hero-h1">{t.h1}</h1>
        <p className="rhp-hero-lede">
          {t.ledePre}{t.effective}
        </p>
      </section>

      <article className="rhl-doc">
        <section className="rhl-sec">
          <h2>{t.s1H}</h2>
          <p>
            {t.s1p1Pre}<em>{t.s1p1Em}</em>{t.s1p1Post}
          </p>
          <p>{t.s1p2}</p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s2H}</h2>
          <p>
            {t.s2p1Pre}<strong>{t.s2p1Strong1}</strong>{t.s2p1Mid}<strong>{t.s2p1Strong2}</strong>{t.s2p1Post}
          </p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s3H}</h2>
          <h3>{t.s3aH}</h3>
          <ul>
            <li><strong>{t.s3aLi1Label}</strong>{t.s3aLi1Body}</li>
            <li><strong>{t.s3aLi2Label}</strong>{t.s3aLi2Body}</li>
            <li><strong>{t.s3aLi3Label}</strong>{t.s3aLi3Body}</li>
            <li><strong>{t.s3aLi4Label}</strong>{t.s3aLi4Body}</li>
          </ul>
          <h3>{t.s3bH}</h3>
          <ul>
            <li><strong>{t.s3bLi1Label}</strong>{t.s3bLi1Body}</li>
            <li><strong>{t.s3bLi2Label}</strong>{t.s3bLi2Body}</li>
            <li><strong>{t.s3bLi3Label}</strong>{t.s3bLi3Body}</li>
          </ul>
          <h3>{t.s3cH}</h3>
          <ul>
            <li><strong>{t.s3cLi1Label}</strong>{t.s3cLi1Body}</li>
            <li><strong>{t.s3cLi2Label}</strong>{t.s3cLi2Body}</li>
            <li><strong>{t.s3cLi3Label}</strong>{t.s3cLi3Body}</li>
          </ul>
        </section>

        <section className="rhl-sec">
          <h2>{t.s4H}</h2>
          <ul>
            <li><strong>{t.s4Li1Label}</strong>{t.s4Li1Body}</li>
            <li><strong>{t.s4Li2Label}</strong>{t.s4Li2Body}</li>
            <li><strong>{t.s4Li3Label}</strong>{t.s4Li3Body}</li>
            <li><strong>{t.s4Li4Label}</strong>{t.s4Li4Body}</li>
            <li><strong>{t.s4Li5Label}</strong>{t.s4Li5Body}</li>
            <li><strong>{t.s4Li6Label}</strong>{t.s4Li6Body}</li>
          </ul>
          <p>
            {t.s4pPre}<strong>{t.s4pStrong}</strong>{t.s4pPost}
          </p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s5H}</h2>
          <p>{t.s5p}</p>
          <ul>
            <li><strong>{t.s5Li1Label}</strong>{t.s5Li1Body}</li>
            <li><strong>{t.s5Li2Label}</strong>{t.s5Li2Body}</li>
            <li><strong>{t.s5Li3Label}</strong>{t.s5Li3Body}</li>
            <li><strong>{t.s5Li4Label}</strong>{t.s5Li4Body}</li>
          </ul>
        </section>

        <section className="rhl-sec">
          <h2>{t.s6H}</h2>
          <p>{t.s6p1}</p>
          <p>{t.s6p2}</p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s7H}</h2>
          <p>{t.s7pIntro}</p>
          <ul>
            <li><strong>{t.s7Li1Label}</strong>{t.s7Li1Body}</li>
            <li><strong>{t.s7Li2Label}</strong>{t.s7Li2Body}</li>
            <li><strong>{t.s7Li3Label}</strong>{t.s7Li3Body}</li>
            <li><strong>{t.s7Li4Label}</strong>{t.s7Li4Body}</li>
            <li><strong>{t.s7Li5Label}</strong>{t.s7Li5Body}</li>
            <li><strong>{t.s7Li6Label}</strong>{t.s7Li6Body}</li>
          </ul>
          <p>{t.s7pOutro}</p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s8H}</h2>
          <p>{t.s8p}</p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s9H}</h2>
          <ul>
            <li><strong>{t.s9Li1Label}</strong>{t.s9Li1Body}</li>
            <li><strong>{t.s9Li2Label}</strong>{t.s9Li2Body}</li>
            <li><strong>{t.s9Li3Label}</strong>{t.s9Li3Body}</li>
            <li><strong>{t.s9Li4Label}</strong>{t.s9Li4Body}</li>
          </ul>
          <p>{t.s9pOutro}</p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s10H}</h2>
          <p>{t.s10p}</p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s11H}</h2>
          <p>{t.s11pIntro}</p>
          <ul>
            <li><strong>{t.s11Li1Label}</strong>{t.s11Li1Body}</li>
            <li><strong>{t.s11Li2Label}</strong>{t.s11Li2Body}</li>
            <li><strong>{t.s11Li3Label}</strong>{t.s11Li3Body}</li>
          </ul>
          <p>{t.s11pOutro}</p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s12H}</h2>
          <p>
            {t.s12p1Pre}<a className="rhl-link" href="mailto:admin@runhq.io">admin@runhq.io</a>{t.s12p1Post}
          </p>
          <p>{t.s12p2}</p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s13H}</h2>
          <p>{t.s13p}</p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s14H}</h2>
          <p>{t.s14p}</p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s15H}</h2>
          <p>{t.s15p}</p>
        </section>

        <section className="rhl-sec">
          <h2>{t.s16H}</h2>
          <p>
            <strong>{t.s16p1Strong}</strong>{t.s16p1Post}
          </p>
          <p>
            {t.s16p2Pre}<a className="rhl-link" href="mailto:admin@runhq.io">admin@runhq.io</a>{t.s16p2Post}
          </p>
        </section>

        <p className="rhl-disclaimer">{t.disclaimer}</p>
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
