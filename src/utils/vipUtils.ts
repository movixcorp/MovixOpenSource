/**
 * vipService.ts - Service centralisé de vérification VIP côté frontend
 * 
 * Au lieu de simplement lire localStorage('is_vip'), ce service :
 * 1. Vérifie périodiquement avec le serveur que la clé est toujours valide dans MySQL
 * 2. Révoque automatiquement le VIP si la clé a expiré ou a été désactivée
 * 3. Fournit un header `x-access-key` pour toutes les requêtes API
 */

const MAIN_API = import.meta.env.VITE_MAIN_API;

// Intervalle de vérification : toutes les 10 minutes
const VIP_CHECK_INTERVAL = 10 * 60 * 1000;

// Cache local pour éviter de spammer le serveur
let lastCheckTime = 0;
let lastCheckResult: boolean | null = null;
let checkInProgress: Promise<boolean> | null = null;

/**
 * Récupère la clé d'accès stockée dans localStorage
 */
export function getAccessKey(): string | null {
  return localStorage.getItem('access_code') || null;
}

/**
 * Vérifie côté serveur si la clé est toujours valide.
 * Cache le résultat pendant 10 minutes.
 * 
 * @param force - Forcer la vérification même si le cache est encore valide
 * @returns true si VIP valide, false sinon
 */
export async function checkVipStatus(force = false): Promise<boolean> {
  const accessKey = getAccessKey();

  // Pas de clé stockée → pas VIP
  if (!accessKey) {
    revokeVipStatus();
    return false;
  }

  // Vérifier le cache (sauf si force)
  const now = Date.now();
  if (!force && lastCheckResult !== null && (now - lastCheckTime < VIP_CHECK_INTERVAL)) {
    return lastCheckResult;
  }

  // Éviter les vérifications simultanées
  if (checkInProgress) {
    return checkInProgress;
  }

  checkInProgress = _performCheck(accessKey);
  try {
    const result = await checkInProgress;
    return result;
  } finally {
    checkInProgress = null;
  }
}

/**
 * Effectue la vérification HTTP vers /api/check-vip
 */
async function _performCheck(accessKey: string): Promise<boolean> {
  try {
    const response = await fetch(`${MAIN_API}/api/check-vip`, {
      method: 'GET',
      headers: {
        'x-access-key': accessKey,
      },
    });

    if (!response.ok) {
      // Erreur serveur — ne pas révoquer immédiatement (tolérance aux pannes)
      console.warn('[VIP] Server error during check, keeping current status');
      return localStorage.getItem('is_vip') === 'true';
    }

    const data = await response.json();

    const previousCheckResult = lastCheckResult;
    lastCheckTime = Date.now();
    lastCheckResult = data.vip === true;

    if (data.vip) {
      let changed = localStorage.getItem('is_vip') !== 'true';

      // Mettre à jour les données d'expiration si le serveur les renvoie
      if (data.expiresAt) {
        // Store as ISO string for consistent Date parsing from localStorage
        const d = new Date(typeof data.expiresAt === 'number' ? data.expiresAt : data.expiresAt);
        const nextExpires = isNaN(d.getTime()) ? String(data.expiresAt) : d.toISOString();
        if (localStorage.getItem('access_code_expires') !== nextExpires) {
          localStorage.setItem('access_code_expires', nextExpires);
          changed = true;
        }
      }
      if (localStorage.getItem('is_vip') !== 'true') {
        localStorage.setItem('is_vip', 'true');
      }

      // Une connexion avec un code VIP pose dÃ©jÃ  `is_vip` avant cette
      // vÃ©rification. Il faut aussi notifier lorsque la vÃ©rification devient
      // positive pour la premiÃ¨re fois, mÃªme si la valeur locale n'a pas changÃ©.
      if (changed || previousCheckResult !== true) {
        window.dispatchEvent(new Event('storage'));
        window.dispatchEvent(new CustomEvent('vipStatusChanged', { detail: { vip: true } }));
      }

      return true;
    } else {
      // Clé invalide/expirée/désactivée → révoquer le VIP
      console.warn('[VIP] Server rejected key:', data.reason || 'unknown');
      revokeVipStatus();
      return false;
    }
  } catch (error) {
    // Erreur réseau — ne pas révoquer (tolérance aux pannes)
    console.warn('[VIP] Network error during check:', error);
    return localStorage.getItem('is_vip') === 'true';
  }
}

/**
 * Révoque le statut VIP local
 */
export function revokeVipStatus(): void {
  localStorage.removeItem('is_vip');
  localStorage.removeItem('access_code');
  localStorage.removeItem('access_code_expires');
  lastCheckResult = false;
  lastCheckTime = Date.now();

  // Notifier les autres onglets et composants
  window.dispatchEvent(new Event('storage'));
  window.dispatchEvent(new CustomEvent('vipStatusChanged', { detail: { vip: false } }));
}

/**
 * Vérifie si l'utilisateur est VIP (lecture locale + vérification serveur en arrière-plan).
 * 
 * Pour les vérifications synchrones rapides (UI rendering), vérifie localStorage.
 * Lance une vérification serveur en arrière-plan si le cache est expiré.
 * 
 * @returns true si le localStorage indique VIP (sera corrigé en arrière-plan si invalide)
 */
export function isUserVip(): boolean {
  const localVip = localStorage.getItem('is_vip') === 'true';

  if (localVip) {
    // Lancer une vérification serveur en arrière-plan (non bloquante)
    const now = Date.now();
    if (now - lastCheckTime > VIP_CHECK_INTERVAL) {
      checkVipStatus().catch(() => { /* ignore */ });
    }
  }

  return localVip;
}

/**
 * Retourne les headers à inclure dans les requêtes API pour la vérification VIP côté serveur.
 * À utiliser dans tous les appels fetch/axios vers le backend.
 */
export function getVipHeaders(): Record<string, string> {
  const accessKey = getAccessKey();
  if (accessKey) {
    return { 'x-access-key': accessKey };
  }
  return {};
}

/**
 * Démarre la vérification automatique périodique du VIP.
 * À appeler au démarrage de l'application (dans App.tsx ou main.tsx).
 */
let intervalId: ReturnType<typeof setInterval> | null = null;

export function startVipVerification(): void {
  // Vérification initiale
  if (getAccessKey()) {
    checkVipStatus(true).catch(() => { /* ignore */ });
  }

  // Arrêter l'intervalle précédent si existant
  if (intervalId) {
    clearInterval(intervalId);
  }

  // Vérification périodique
  intervalId = setInterval(() => {
    if (getAccessKey()) {
      checkVipStatus().catch(() => { /* ignore */ });
    }
  }, VIP_CHECK_INTERVAL);
}

/**
 * Arrête la vérification automatique périodique.
 */
export function stopVipVerification(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
