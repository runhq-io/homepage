'use client';

import Script from 'next/script';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

import { GA_MEASUREMENT_ID, pageview } from '@/lib/gtag';

export function GoogleAnalytics() {
  const pathname = usePathname();
  const gaId = GA_MEASUREMENT_ID;

  useEffect(() => {
    if (!gaId) return;
    if (!pathname) return;

    // Avoid useSearchParams() (it can require Suspense boundaries during static export).
    const pagePath = typeof window !== 'undefined' ? `${window.location.pathname}${window.location.search}` : pathname;
    pageview(pagePath);
  }, [gaId, pathname]);

  if (!gaId) return null;

  return (
    <>
      <Script src={`https://www.googletagmanager.com/gtag/js?id=${gaId}`} strategy="afterInteractive" />
      <Script id="google-analytics" strategy="afterInteractive">
        {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', '${gaId}', {
            send_page_view: false,
            debug_mode: ${process.env.NODE_ENV === 'production' ? 'false' : 'true'},
          });
        `}
      </Script>
    </>
  );
}
