import type { Metadata, Viewport } from 'next';
import { GoogleAnalytics } from '@/components/analytics/GoogleAnalytics';
import './globals.css';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
};

export const metadata: Metadata = {
  title: 'RunHQ: Console',
  description: 'RunHQ: Console Application',
  applicationName: 'RunHQ Console',
  manifest: '/site.webmanifest',
  icons: {},
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      {/* Match marketing site base layout/typography defaults */}
      <body className="min-h-screen overflow-x-hidden">
        <GoogleAnalytics />
        {children}
      </body>
    </html>
  );
}
