// 알림을 받는 서비스 워커. 화면을 닫아 둔 동안 서버가 보낸 푸시를 알림으로 띄우고, 누르면 그 에이전트로 데려간다.
//
// fetch 를 가로채지 않는다 — 화면을 읽는 길에는 끼어들지 않으므로 여는 속도는 그대로다. 알림을 켠 브라우저에만 깔린다.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data.json();
  } catch {
    // 글 없이 온 푸시도 알림은 띄운다 — 받고도 띄우지 않으면 브라우저가 구독을 거둔다.
  }
  const id = typeof d.id === "string" ? d.id : "";
  e.waitUntil(
    (async () => {
      // 지금 이 화면을 보고 있으면 화면의 토스트로 충분하다. 받은 푸시를 띄우지 않아도 되는 것은 Chrome 계열이
      // "창이 앞에 떠 있을 때"만 봐주는 예외라서, 그 푸시 서버(FCM)로 온 것일 때만 건너뛴다.
      const sub = await self.registration.pushManager.getSubscription();
      if (sub && new URL(sub.endpoint).host === "fcm.googleapis.com") {
        const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        if (windows.some((w) => w.focused && w.visibilityState === "visible")) return;
      }
      await self.registration.showNotification(d.title || "Agent World", {
        body: d.body || "",
        icon: "/icon-192.png",
        // 같은 에이전트의 알림은 한 장으로 갈아 끼우되, 바뀔 때마다 다시 울린다.
        ...(id ? { tag: id, renotify: true } : {}),
        data: { id },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const id = (e.notification.data && e.notification.data.id) || "";
  e.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows[0];
      if (open) {
        open.postMessage({ select: id });
        return open.focus();
      }
      return self.clients.openWindow(id ? `/#a=${encodeURIComponent(id)}` : "/");
    })(),
  );
});
