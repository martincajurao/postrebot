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
    vibrate: [200, 100, 200],
    actions: [{ action: 'open', title: 'Open Admin' }],
  };
  // OS notifications cannot run JS or TTS, so also forward the payload to every
  // open admin page — the page plays a chime and speaks the order aloud.
  const pushId = (self.crypto && self.crypto.randomUUID)
    ? self.crypto.randomUUID()
    : String(Date.now()) + '-' + Math.random().toString(36).slice(2);
  const notify = self.registration.showNotification(title, options).catch((err) => {
    console.error('[sw] showNotification failed:', err);
    return self.registration.showNotification('Postre Admin', { body: 'New activity' });
  });
  const forward = self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
    for (const client of clientList) {
      client.postMessage({ type: 'push-order', id: pushId, title, body: options.body, tag: options.tag });
    }
  });
  event.waitUntil(Promise.all([notify, forward]));
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
