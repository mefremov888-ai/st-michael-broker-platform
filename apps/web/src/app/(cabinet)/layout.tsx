'use client';

import { useEffect, useState } from 'react';
import { Sidebar } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { BottomNav } from '@/components/BottomNav';
import { OnboardingTour, getOnboardingSteps } from '@/components/OnboardingTour';
import { useAuth } from '@/lib/auth';

const ONBOARDING_KEY_PREFIX = 'stm_onboarding_seen_';

export default function CabinetLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { broker, loading } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);

  useEffect(() => {
    if (!broker) return;
    const key = ONBOARDING_KEY_PREFIX + broker.id;
    if (!localStorage.getItem(key)) {
      setTourOpen(true);
      localStorage.setItem(key, '1');
    }
  }, [broker]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-text-muted">Загрузка...</div>
      </div>
    );
  }

  if (!broker) return null;

  return (
    <div className="min-h-screen bg-background">
      <TopBar onMenuToggle={() => setSidebarOpen(!sidebarOpen)} onHelp={() => setTourOpen(true)} />
      <div className="flex">
        <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        <main className="flex-1 p-4 sm:p-6 min-w-0 pb-20 lg:pb-6">
          <Breadcrumbs />
          {children}
        </main>
      </div>
      <BottomNav />
      <OnboardingTour
        steps={getOnboardingSteps(broker.role !== 'BROKER')}
        open={tourOpen}
        onClose={() => setTourOpen(false)}
      />
    </div>
  );
}
