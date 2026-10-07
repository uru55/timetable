// Service Worker：インストール判定 + プッシュ通知の受信
// （キャッシュはしないので、サイトの更新が古いまま残ることはありません）
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  e.respondWith(fetch(e.request));
});

// --- Firebase Cloud Messaging（読み込めなくても他の機能は動くようにしておく） ---
try {
  importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');
  firebase.initializeApp({
    apiKey: "AIzaSyALuD1Iw_LvgMcaYD1twnBCRQbvtLjO_fc",
    authDomain: "timetable-14434.firebaseapp.com",
    projectId: "timetable-14434",
    storageBucket: "timetable-14434.firebasestorage.app",
    messagingSenderId: "79300780666",
    appId: "1:79300780666:web:65d0b524f81d85457bd1c3"
  });
  const messaging = firebase.messaging();
  // アプリが閉じているときにプッシュが届いたら、通知を表示する
  messaging.onBackgroundMessage((payload) => {
    const d = (payload && payload.data) || {};
    return self.registration.showNotification(d.title || '時間割', {
      body: d.body || '',
      icon: 'icons/icon-192.png',
      tag: d.tag || 'notice',
      data: { url: d.url || './' }
    });
  });
} catch (err) {
  // オフラインなどで読み込めなかった場合は、通知なしで続行
}

// 通知をタップしたら、サイトを開く（すでに開いていればそのタブを前面に）
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) return c.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
