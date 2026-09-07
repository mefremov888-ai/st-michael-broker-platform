// ST Michael — service worker for web push notifications
// Scope: / (entire app)

self.addEventListener('install', (event) => {
  // Activate this SW immediately on first install / update
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload = {};
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'ST Michael', body: event.data.text() };
  }

  const title = payload.title || 'ST Michael';
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/icon-192.png',
    badge: payload.badge || '/icon-192.png',
    tag: payload.tag,
    data: { url: payload.url || '/' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
      // If a window with the target URL is already open — focus it
      const existing = clientsArr.find((c) => {
        try { return new URL(c.url).pathname === new URL(url, self.location.origin).pathname; }
        catch { return false; }
      });
      if (existing) return existing.focus();
      return self.clients.openWindow(url);
    }),
  );
});
