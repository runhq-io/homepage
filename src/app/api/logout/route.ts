import { signOut } from '@/lib/auth';

/**
 * Server-side sign-out endpoint.
 *
 * Unlike the client-side signOut() from next-auth/react (which does a fetch
 * + window.location.href redirect), this clears the session cookie and
 * redirects to /login in a single HTTP response — eliminating the race
 * condition where the browser navigates to /login before the Set-Cookie
 * from the fetch response has been fully processed.
 */
export async function GET() {
  await signOut({ redirectTo: '/login' });
}
