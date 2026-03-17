const DEVICE_ID_STORAGE = "zchat_device_id_v1";

export function getDeviceId() {
  let deviceId = localStorage.getItem(DEVICE_ID_STORAGE);
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_STORAGE, deviceId);
  }
  return deviceId;
}

export function getDeviceLabel() {
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return "Android device";
  if (/iphone|ipad|ipod/i.test(ua)) return "iPhone or iPad";
  if (/windows/i.test(ua)) return "Windows browser";
  if (/macintosh|mac os x/i.test(ua)) return "Mac browser";
  if (/linux/i.test(ua)) return "Linux browser";
  return "Web browser";
}
