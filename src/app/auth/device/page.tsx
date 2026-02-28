import DeviceAuthClient from './DeviceAuthClient';

// This page depends on query params + auth state and must not be cached as a static HTML shell.
// Forcing dynamic prevents long-lived cached HTML from referencing stale hashed /_next/static assets.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default function DeviceAuthPage() {
  return <DeviceAuthClient />;
}
