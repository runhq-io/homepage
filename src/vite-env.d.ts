/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** RunHQ backend API URL. */
  readonly VITE_API_URL?: string;
  /** Google Analytics 4 Measurement ID (e.g. G-XXXXXXXXXX). Unset disables analytics. */
  readonly VITE_GA_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
