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

Two systems measure this site, and they answer different questions.

### Google Analytics 4 — *how many*

Loaded via `src/analytics.ts` under **Consent Mode v2**. gtag.js loads for every
visitor with all storage denied, so GA can count a visit and model the aggregate
while setting no cookies; accepting the consent bar upgrades that to ordinary
cookie-based analytics, declining leaves the visitor cookieless forever. This is
what makes a visitor who lands and bounces count as one rather than zero.

The Measurement ID is plain config, not a secret — it ships in cleartext in
every bundle — and is declared per environment in the deploy workflows:
production `G-PK433W7S1P`, staging `none` (the explicit opt-out; see
`resolveGaId`). Local builds stay off unless given an ID.

### The RunHQ SDK — *who*

`widget.js` is one script carrying two products. Beyond the feedback widget it
runs RunHQ's own acquisition/CRM tracker: page views, first-touch attribution,
`?runhq_ref=` referrals, and the `identify`/`stage`/`track` calls that turn an
anonymous visitor into a person. `src/telemetry.ts` is the whole of the site's
use of it — one file to read to know what RunHQ records about its own visitors.

Visitor traffic is recorded in its own RunHQ project, **`runhq-homepage`** —
the feedback widget stays on the `runhq` board. The widget is always initialised
with `track: false`; the tracker is started by the SDK's tracking-only mode
(`data-project="runhq-homepage" data-track-only="true" data-environment=…` on
the `widget.js` tag). For a returning visitor who has already accepted, that is
the one tag the page loads; a visitor who clicks Accept mid-visit gets a
tracking-only copy injected then, because the SDK reads that mode only at load.
Tracking must be switched on in `runhq-homepage`'s SDK settings, or `/collect`
answers `{"tracking":"disabled"}`.

Two rules govern it:

- **Consent gates it.** Unlike GA this tracker has no cookieless mode — its
  visitor id is a real `rw_anon_id` in localStorage, mirrored to a cookie on
  `.runhq.io` — so it rides the same Accept/Decline switch as GA and stays
  dormant until the visitor accepts. Nothing is lost by waiting: GA already
  counts every visit, so what consent buys is the identified funnel on top.
  Declining also drops any ids the visitor is already carrying.
- **The environment is explicit.** The SDK assumes `production` when an embed
  says nothing, which is how staging traffic lands in production numbers.
  `VITE_RUNHQ_ENV` is declared per environment in the deploy workflows; if it is
  ever forgotten, the value is inferred from the build mode and API host and can
  only come out `production` for a production build against the production API.

The `/:slug` board's own `init()` never tracks: the SDK pins the project it was
initialised with for the lifetime of the page, so tracking there wrote RunHQ's
own marketing page views into whichever customer's project the visitor had
opened. Page views on `www.runhq.io/:slug` still go to `runhq-homepage`.

> **Note on the previously-committed GA ID.** An earlier revision briefly
> hardcoded the Measurement ID `G-PK433W7S1P` in `index.html`. It has been
> removed from the source, but it remains in git history. A GA4 Measurement ID
> is public by design (served to every visitor's browser) and is not a secret,
> but it can be used to send spoofed hits. Auditing and, if desired, rotating
> that GA property is a manual account-side action tracked outside this repo.

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
