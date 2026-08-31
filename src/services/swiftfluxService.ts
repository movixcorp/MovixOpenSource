// src/services/swiftfluxService.ts
//
// SwiftFlux — le catalogue partenaire SwiftFlow servi en MP4 progressif dans le
// lecteur Movix, au lieu de son iframe.
//
// Il n'y a pas de requête de disponibilité à part : l'appel amont rend l'URL du
// fichier en même temps que de quoi construire l'iframe, donc le serveur joint
// un bloc `mp4` aux réponses `/api/swiftflow/movie/:id` et
// `/api/swiftflow/tv/:id/season/:s` déjà faites par les pages. `readSwiftflux`
// lit ce bloc.
//
// Ce bloc ne contient jamais l'URL — il part au chargement de chaque fiche, il
// serait sinon un robinet à liens directs. L'adresse s'obtient dans un second
// temps, contre un jeton Turnstile (`resolveSwiftfluxPlayback`). Entre les
// deux, l'interface fait regarder une publicité — dont les VIP sont dispensés,
// mais pas de la vérification.
//
// L'URL rendue est celle du CDN partenaire, sans relais : il autorise les
// domaines Movix par `Referer` et le navigateur envoie le bon tout seul.
import axios from 'axios';
import { getVipHeaders } from '../utils/vipUtils';

const MAIN_API = import.meta.env.VITE_MAIN_API;

export interface SwiftfluxEntry {
  index: number;
  label: string;
  quality: string | null;
  size: string | null;
  language: string;
}

export interface SwiftfluxAvailability {
  available: boolean;
  entries: SwiftfluxEntry[];
}

export interface SwiftfluxPlayback extends SwiftfluxEntry {
  url: string;
}

const EMPTY: SwiftfluxAvailability = { available: false, entries: [] };

/**
 * Lit le bloc `mp4` d'une réponse catalogue SwiftFlow.
 *
 * Tolère l'absence du champ : une réponse d'erreur, un cache encore froid
 * (`pending`) ou un serveur pas encore à jour rendent simplement « indisponible ».
 */
export function readSwiftflux(swiftflowResponse: unknown): SwiftfluxAvailability {
  const block = (swiftflowResponse as { mp4?: unknown } | null | undefined)?.mp4 as
    | { available?: boolean; entries?: SwiftfluxEntry[] }
    | undefined;
  if (!block || block.available !== true || !Array.isArray(block.entries)) return EMPTY;
  return { available: block.entries.length > 0, entries: block.entries };
}

export interface ResolveSwiftfluxParams {
  kind: 'movie' | 'tv';
  tmdbId: string | number;
  season?: number;
  episode?: number;
  index?: number;
  turnstileToken: string;
}

/**
 * Échange le jeton Turnstile contre l'URL de lecture.
 *
 * Rejette avec un message affichable : le serveur renvoie 400/403 quand le
 * jeton manque ou a expiré, ce qui doit ramener l'utilisateur au widget plutôt
 * que de le laisser devant un lecteur vide.
 */
export async function resolveSwiftfluxPlayback(
  params: ResolveSwiftfluxParams,
): Promise<SwiftfluxPlayback> {
  if (!MAIN_API) throw new Error('API indisponible');
  try {
    const { data } = await axios.post(
      `${MAIN_API}/api/swiftflow/mp4/resolve`,
      params,
      { headers: getVipHeaders() },
    );
    if (!data?.success || !data?.url) {
      throw new Error(data?.error || 'Lecture indisponible');
    }
    return data as SwiftfluxPlayback;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      throw new Error(error.response?.data?.error || 'Lecture indisponible');
    }
    throw error;
  }
}
