# RunHQ Homepage

Marketing landing page for RunHQ — spearheading the agent transformation for business.

## Tech Stack

- **Build Tool**: [Vite](https://vitejs.dev/)
- **Framework**: React 18
- **3D Graphics**: [Three.js](https://threejs.org/) + [React Three Fiber](https://docs.pmnd.rs/react-three-fiber)
- **Styling**: Tailwind CSS

## Development

```bash
# Install dependencies
npm install

# Run development server
npm run dev
```

The homepage runs on `http://localhost:5173`

## Testing

```bash
npm test        # Run tests (watch mode)
npm run test:run    # Run tests once
```

## Build

```bash
# Build for production
npm run build

# Preview production build
npm run preview
```

Output is generated in the `dist/` directory.

## Deployment

Deployed via **Cloudflare Pages** (project: `fishtank-homepage`). Requires manual deploy via `npx wrangler pages deploy dist --project-name=fishtank-homepage`.

- **Custom domain**: `runhq.io` (CNAME → `fishtank-9xf.pages.dev`)
- **Build command**: `npm run build`
- **Output directory**: `dist`

## Analytics

Google Analytics 4 is loaded via `src/analytics.ts`, gated behind an explicit
cookie-consent banner (Consent Mode v2 — nothing reaches Google until the
visitor opts in). The Measurement ID is **not** committed; it is injected at
build time from the GitHub Actions repo secret `VITE_GA_ID` (see
`.github/workflows/deploy-*.yml`). Leaving it unset disables analytics, which
is the default for local development.

> **Note on the previously-committed ID.** An earlier revision briefly hardcoded
> the Measurement ID `G-PK433W7S1P` in `index.html`. It has been removed from
> the source, but it remains in git history. A GA4 Measurement ID is public by
> design (served to every visitor's browser) and is not a secret, but it can be
> used to send spoofed hits. Auditing and, if desired, rotating that GA property
> is a manual account-side action tracked outside this repo.

## Project Structure

```
homepage/
├── public/          # Static assets
├── src/             # Source code
│   ├── components/  # React components
│   └── ...
├── index.html       # Entry HTML
├── vite.config.ts   # Vite configuration
└── tailwind.config.js
```
