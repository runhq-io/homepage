/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** RunHQ backend API URL. */
  readonly VITE_API_URL?: string;
  /** Google Analytics 4 Measurement ID (e.g. G-XXXXXXXXXX). Unset disables analytics. */
  readonly VITE_GA_ID?: string;
  /**
   * Which deployment RunHQ's own telemetry reports as: `production`, `staging`
   * or `development`. Unset is inferred (never as production unless this is the
   * production build) — see resolveTelemetryEnv in telemetry.ts.
   */
  readonly VITE_RUNHQ_ENV?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
