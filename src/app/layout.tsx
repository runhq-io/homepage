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
  title: 'Fishtank: Console',
  description: 'Fishtank: Console Application',
  applicationName: 'Fishtank Console',
  manifest: '/site.webmanifest',
  icons: {
    icon: [
      { url: '/favicon.ico' },
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
  },
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
