import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ToastHost } from '@/components/Toast';

export const metadata: Metadata = {
  title: 'Governance layer — agent control plane',
  description:
    'Permission, budget and revocation controls for a fleet of autonomous financial agents.',
};

export const viewport: Viewport = {
  themeColor: '#0B0E13',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ToastHost>{children}</ToastHost>
      </body>
    </html>
  );
}
