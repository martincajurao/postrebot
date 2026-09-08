/* Service Worker for Postre Admin PWA
 * - Handles push notifications for new orders
 * - Updates app badge with pending order count
 * - Does NOT cache API requests (Supabase, auth, webhooks)
 * - Does NOT interfere with Messenger webview functionality
 */

const ADMIN_SCOPE = '/admin';

// Install: skip waiting to activate immediately
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// Activate: claim all clients
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Push notification handler
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
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag || 'new-order',
    data: data.data || {},
    requireInteraction: true,
    vibrate: [200, 100, 200],
    actions: [{ action: 'open', title: 'Open Admin' }],
  };

  // Forward push to all open admin pages for in-app notifications
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

// Notification click handler
self.addEventListener('notificationclick', (event) => {
  const action = event.action || 'open';
  event.notification.close();
  event.waitUntil(
    action === 'open'
      ? self.clients.openWindow(ADMIN_SCOPE)
      : Promise.resolve(),
  );
});

// Handle messages from the app (e.g., update badge count)
self.addEventListener('message', (event) => {
  // Badge is handled by the client app using navigator.setAppBadge()
  // No action needed in service worker
});

// Fetch handler - pass through all requests without caching
// This ensures Supabase, auth, webhooks, and API requests work normally
self.addEventListener('fetch', (event) => {
  // Only handle navigation requests for the admin panel
  if (event.request.mode === 'navigate') {
    // Let the browser handle navigation normally
    return;
  }
  // For all other requests (API, images, etc.), pass through without interception
  return;
});