/**
 * Détection « appareil mobile/tablette » côté client, pour choisir quoi
 * proposer à l'utilisateur : l'appli mobile (Android/iOS) ou l'extension
 * navigateur (PC/Mac). L'iPad sous iPadOS se présente comme « Macintosh » :
 * on le rattrape via le multi-touch.
 */
export function isMobileOrTabletDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod|Windows Phone|Mobile/i.test(ua)) return true;
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
}
