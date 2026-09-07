'use client';

import { api, apiPost } from './api';

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const b64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function isPushSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export async function getPushPermissionState(): Promise<NotificationPermission | 'unsupported'> {
  if (!isPushSupported()) return 'unsupported';
  return Notification.permission;
}

async function registerSW(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (existing) return existing;
  return navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

export async function subscribePush(): Promise<{ ok: boolean; reason?: string }> {
  if (!isPushSupported()) return { ok: false, reason: 'unsupported' };

  // HTTPS or localhost only — Notification API will reject otherwise
  if (typeof window !== 'undefined') {
    const isSecure = window.isSecureContext;
    if (!isSecure) return { ok: false, reason: 'insecure-context' };
  }

  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return { ok: false, reason: 'denied' };

  const reg = await registerSW();

  // Fetch VAPID public key from API
  const res = await fetch('/api/notifications/push/vapid-key');
  if (!res.ok) return { ok: false, reason: 'no-vapid-key' };
  const { publicKey } = await res.json();
  if (!publicKey) return { ok: false, reason: 'vapid-not-configured' };

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    });
  }

  const json = sub.toJSON();
  await apiPost('/notifications/push/subscribe', {
    endpoint: json.endpoint,
    keys: json.keys,
  });

  return { ok: true };
}

export async function unsubscribePush(): Promise<{ ok: boolean }> {
  if (!isPushSupported()) return { ok: true };

  const reg = await navigator.serviceWorker.getRegistration('/');
  if (!reg) return { ok: true };

  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    await api(`/notifications/push/unsubscribe?endpoint=${encodeURIComponent(endpoint)}`, {
      method: 'DELETE',
    });
  }

  return { ok: true };
}

export async function getPushStatus(): Promise<{
  supported: boolean;
  permission: NotificationPermission | 'unsupported';
  subscribed: boolean;
}> {
  const supported = isPushSupported();
  const permission = await getPushPermissionState();

  let subscribed = false;
  if (supported && permission === 'granted') {
    try {
      const reg = await navigator.serviceWorker.getRegistration('/');
      const sub = await reg?.pushManager.getSubscription();
      subscribed = !!sub;
    } catch {}
  }

  return { supported, permission, subscribed };
}
