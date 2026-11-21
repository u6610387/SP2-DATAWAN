/**
 * Minimal service worker: Web Push notifications for the owner PWA only (CLAUDE.md §3.4 —
 * owner alerts are VAPID Web Push, never LINE push). No offline shell / asset caching —
 * the dashboard is expected to always be fetched fresh while open.
 */
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = { title: 'ดาทะวันซีฟู้ด', body: '' };
  try {
    if (event.data) data = event.data.json();
  } catch {
    // ignore malformed payloads
  }
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body, icon: '/icon.svg', badge: '/icon.svg' }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow('/dashboard'));
});
