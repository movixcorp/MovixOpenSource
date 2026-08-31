// src/utils/serverResolveRequest.ts
//
// Config axios commune des appels catalogue en contexte de lecture, pilotée
// par la méthode d'extraction choisie dans les réglages (`extractionPrefs`).
//
// - Méthode « server » AVEC VIP valide : `resolve=1` + clé VIP en header. Le
//   serveur résout lui-même les m3u8 (extraction VIP) et les renvoie dans la
//   réponse.
// - Méthode « extension » / « userscript », OU méthode « server » sans VIP :
//   ni `resolve`, ni clé VIP. Le serveur renvoie les liens embed bruts et
//   l'extraction reste 100 % locale (extension/userscript). Envoyer quand
//   même la clé déclenchait une extraction serveur parasite qui se mélangeait
//   aux résultats de l'extension — d'où des sources tantôt VIP, tantôt
//   extension selon la requête la plus rapide.
//
// La clé VIP reste envoyée partout ailleurs (débridage `/api/media/debrid`,
// resolve MP4 SwiftFlux, proxy PurStream, Live TV…) : ces usages-là ne sont
// pas de l'extraction de sources et ne dépendent pas de la méthode choisie.

import { getVipHeaders, isUserVip } from './vipUtils';
import { getExtractionMethod } from './extractionPrefs';

/**
 * Bridge local (extension ou userscript) déjà injecté ? Les deux canaux
 * posent ces globals à `document_start`, avant que l'app démarre — un test
 * synchrone suffit donc, pas d'attente (voir extractM3u8.ts).
 */
function hasLocalBridge(): boolean {
  return typeof window !== 'undefined'
    && !!(window.hasMovixNexusExtractor && window.movixExtractM3u8);
}

/**
 * Vrai si l'extraction doit passer par le serveur.
 *
 * La méthode choisie dans les réglages est respectée quand elle est
 * disponible, avec REPLI AUTOMATIQUE sinon :
 * - méthode « server » choisie : serveur si VIP ; sans VIP, repli sur le
 *   bridge local s'il est injecté (les appelants testent
 *   `hasNexusExtractors()` quand cette fonction rend false) ;
 * - méthode « extension »/« userscript » choisie : bridge local s'il est
 *   injecté ; sinon repli sur le serveur si le compte est VIP ;
 * - rien de disponible : l'extraction échoue et les sources restent
 *   jouables en iframe.
 */
export function usesServerExtraction(): boolean {
  if (!isUserVip()) return false;
  return getExtractionMethod() === 'server' || !hasLocalBridge();
}

export interface ServerResolveRequestConfig {
  params: Record<string, unknown>;
  headers: Record<string, string>;
}

/**
 * Config `{ params, headers }` d'un appel catalogue de lecture.
 *
 * @param extraParams Paramètres propres à l'appel (saison, épisode…), fusionnés
 *                    avec `resolve=1` uniquement en méthode serveur.
 */
export function serverResolveRequest(
  extraParams: Record<string, unknown> = {},
): ServerResolveRequestConfig {
  if (usesServerExtraction()) {
    return { params: { ...extraParams, resolve: 1 }, headers: { ...getVipHeaders() } };
  }
  return { params: { ...extraParams }, headers: {} };
}
