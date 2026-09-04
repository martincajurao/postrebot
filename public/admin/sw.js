/* Service worker for Postre admin — receives push events and shows notifications. */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { title: 'Postre Admin', body: event.data ? String(event.data.text()).slice(0, 200) : 'New activity' };
  }
  const title = data.title || 'Postre Admin';
  const options = {
    body: data.body || '',
    icon: '/admin/icon-192.svg',
    badge: '/admin/icon-192.svg',
    tag: data.tag || 'new-order',
    data: data.data || {},
    requireInteraction: true,
    actions: [{ action: 'open', title: 'Open Admin' }],
  };
  event.waitUntil(
    self.registration.showNotification(title, options).catch((err) => {
      console.error('[sw] showNotification failed:', err);
      return self.registration.showNotification('Postre Admin', { body: 'New activity' });
    }),
  );
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
