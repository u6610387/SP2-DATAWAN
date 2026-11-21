import type { Metadata, Viewport } from 'next';
import { LanguageProvider } from '@/lib/i18n/context';
import './globals.css';

export const metadata: Metadata = {
  title: 'ดาทะวันซีฟู้ด',
  description: 'Owner dashboard & order room — Da Tawan Seafood',
  manifest: '/manifest.json',
  icons: { icon: '/icon.svg' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#0e7490',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th">
      <body className="min-h-dvh font-sans antialiased">
        <LanguageProvider>{children}</LanguageProvider>
      </body>
    </html>
  );
}
