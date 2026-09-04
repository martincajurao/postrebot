/// <reference lib="webworker" />
/* Service worker for Postre admin — receives push events and shows notifications. */
self.addEventListener('push', (event) => {
  if (!event.data) return;
  const data = event.data.json();
  const title = data.title || 'Postre Admin';
  const options = {
    body: data.body || '',
    icon: '/admin/icon-192.svg',
    badge: '/admin/icon-192.svg',
    tag: data.tag || 'new-order',
    data: data.data || {},
    requireInteraction: true,
    actions: [
      { action: 'open', title: 'Open Admin', icon: '/admin/icon-192.svg' },
    ],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  const action = event.action || 'open';
  event.notification.close();
  event.waitUntil(
    action === 'open'
      ? self.clients.openWindow('/admin')
      : Promise.resolve(),
  );
});

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});