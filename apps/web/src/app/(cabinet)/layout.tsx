'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Sidebar } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { BottomNav } from '@/components/BottomNav';
import { OnboardingTour, getCmsOnboardingSteps, getOnboardingSteps } from '@/components/OnboardingTour';
import { useAuth } from '@/lib/auth';

const ONBOARDING_KEY_PREFIX = 'stm_onboarding_seen_';
const CMS_ONBOARDING_KEY_PREFIX = 'stm_cms_onboarding_seen_';
const CMS_ROUTES = [
  '/admin/commission-policies',
  '/admin/content',
  '/admin/documents',
  '/admin/promos',
  '/admin/events',
  '/admin/projects',
  '/admin/news',
];

export default function CabinetLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { broker, loading } = useAuth();
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const isCmsArea = broker?.role === 'ADMIN' && CMS_ROUTES.some((route) => pathname.startsWith(route));

  useEffect(() => {
    if (!broker) return;
    const key = (isCmsArea ? CMS_ONBOARDING_KEY_PREFIX : ONBOARDING_KEY_PREFIX) + broker.id;
    if (!localStorage.getItem(key)) {
      setTourOpen(true);
      localStorage.setItem(key, '1');
    }
  }, [broker, isCmsArea]);

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
        steps={isCmsArea ? getCmsOnboardingSteps() : getOnboardingSteps(broker.role !== 'BROKER')}
        open={tourOpen}
        onClose={() => setTourOpen(false)}
      />
    </div>
  );
}
