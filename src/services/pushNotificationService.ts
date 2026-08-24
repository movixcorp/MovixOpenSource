import axios from 'axios';

const API_URL = import.meta.env.VITE_MAIN_API;
const CONFIGURED_VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY;
let vapidPublicKeyPromise: Promise<string | null> | null = null;

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function getPushPermission(): NotificationPermission {
  if (!isPushSupported()) return 'denied';
  return Notification.permission;
}

/** Vérifie si l'utilisateur a déjà une subscription push active */
export async function isSubscribed(): Promise<boolean> {
  if (!isPushSupported()) return false;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    return subscription !== null;
  } catch {
    return false;
  }
}

/** Vérifie si l'utilisateur a déjà vu la bannière (et l'a ignorée) */
const PUSH_BANNER_DELAY_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours

export function hasDismissedPushBanner(): boolean {
  const dismissedAt = localStorage.getItem('push_banner_dismissed_at');
  if (!dismissedAt) return false;
  return Date.now() - parseInt(dismissedAt, 10) < PUSH_BANNER_DELAY_MS;
}

export function dismissPushBanner(): void {
  localStorage.setItem('push_banner_dismissed_at', Date.now().toString());
}

export function dismissPushBannerPermanently(): void {
  localStorage.setItem('push_banner_dismissed_permanently', 'true');
}

export function hasDismissedPermanently(): boolean {
  return localStorage.getItem('push_banner_dismissed_permanently') === 'true';
}

export function resetPushBannerDismissal(): void {
  localStorage.removeItem('push_banner_dismissed_at');
  localStorage.removeItem('push_banner_dismissed_permanently');
}

async function getVapidPublicKey(): Promise<string | null> {
  if (CONFIGURED_VAPID_PUBLIC_KEY) return CONFIGURED_VAPID_PUBLIC_KEY;
  if (!vapidPublicKeyPromise) {
    vapidPublicKeyPromise = axios
      .get(`${API_URL}/api/comments/notifications/push/vapid-key`)
      .then((response) => response.data?.publicKey || null)
      .catch(() => null);
  }
  return vapidPublicKeyPromise;
}

/** Demande la permission et souscrit aux push notifications */
export async function subscribeToPush(): Promise<boolean> {
  if (!isPushSupported()) return false;

  try {
    const vapidPublicKey = await getVapidPublicKey();
    if (!vapidPublicKey) return false;
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return false;

    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    });

    const token = localStorage.getItem('auth_token');
    if (!token) return false;

    await axios.post(
      `${API_URL}/api/comments/notifications/push/subscribe`,
      { subscription: subscription.toJSON() },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    resetPushBannerDismissal();
    return true;
  } catch (error) {
    console.error('Erreur lors de la souscription push:', error);
    return false;
  }
}

/** Se désabonner des push notifications */
export async function unsubscribeFromPush(): Promise<boolean> {
  if (!isPushSupported()) return false;

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return true;

    const token = localStorage.getItem('auth_token');
    if (token) {
      await axios.delete(`${API_URL}/api/comments/notifications/push/unsubscribe`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { endpoint: subscription.endpoint },
      });
    }

    await subscription.unsubscribe();
    return true;
  } catch (error) {
    console.error('Erreur lors de la désinscription push:', error);
    return false;
  }
}
