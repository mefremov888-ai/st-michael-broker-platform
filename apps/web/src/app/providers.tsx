'use client';

import { AuthProvider } from '@/lib/auth';
import { ToastProvider } from '@/components/Toast';
import { ReactNode } from 'react';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <ToastProvider>{children}</ToastProvider>
    </AuthProvider>
  );
}
