export async function requestNotificationAccess() {
  if (!("Notification" in window)) return "unsupported" as const;
  if (Notification.permission === "granted") return "granted" as const;
  const permission = await Notification.requestPermission();
  return permission;
}

export function showDesktopNotification(title: string, body: string, tag: string) {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;

  const notification = new Notification(title, {
    body,
    tag,
    silent: false,
  });

  notification.onclick = () => {
    window.focus();
    notification.close();
  };
}
