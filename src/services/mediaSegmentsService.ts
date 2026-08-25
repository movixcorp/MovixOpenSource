// src/services/mediaSegmentsService.ts
//
// Recuperation des segments (intro / resume / outro / credits / apercu) d'un
// episode ou d'un film.
//
// L'interrogation des fournisseurs (AniSkip, SkipDB, IntroDB, TheIntroDB), leur
// confrontation et la validation contre la duree du flux se font cote Mainapi
// (`API/Mainapi/services/mediaSegments/`) : cache Redis partage entre tous les
// utilisateurs, pas de dependance au CORS de quatre services tiers, et un seul
// aller-retour au lieu de six en cascade.
//
// Le payload renvoye est independant des reglages de l'utilisateur : il porte
// le consensus calcule sur tous les fournisseurs ET le detail de chaque
// proposition. C'est `utils/segmentConsensus.ts` qui le retaille selon les
// fournisseurs choisis, ce qui evite de fragmenter le cache serveur.

import axios from 'axios';
import { MAIN_API } from '../config/runtime';
import type { ProviderId, SegmentKind } from '../utils/skipSegmentPrefs';

export interface SegmentCandidate {
  source: ProviderId;
  start: number;
  end: number;
  confidence: number;
  /** Qualite du recalage quand le fournisseur sait le faire (`exact`, `shifted`). */
  match?: string | null;
}

export interface MediaSegment {
  type: SegmentKind;
  /** Secondes, deja validees contre la duree transmise a l'appel. */
  start: number;
  end: number;
  /** 0–1, majoree quand plusieurs fournisseurs s'accordent. */
  confidence: number;
  /** Part des fournisseurs ayant repondu qui s'accordent sur ce segment. */
  agreement: number;
  sourceCount: number;
  sources: ProviderId[];
  /** Fournisseur ayant servi de reference pour les bornes. */
  source: ProviderId;
  match?: string | null;
  /** Detail de chaque proposition, pour le recalcul cote client. */
  candidates: SegmentCandidate[];
}

/** `ok` | `empty` | `error` | `timeout` | `unconfigured` | `unsupported` | `no-id` */
export type ProviderStatus = string;

/**
 * Proposition deposee depuis le studio du lecteur.
 *
 * Tout est en millisecondes : c'est la resolution a laquelle le studio laisse
 * regler les bornes, et repasser en secondes ici jetterait ce travail.
 */
export interface CommunitySubmission {
  id: string;
  type: SegmentKind;
  startMs: number;
  endMs: number;
  /** Duree du flux sur lequel le releve a ete fait. */
  referenceDurationMs: number;
  votesUp: number;
  votesDown: number;
  /** Nombre de voix venant de l'equipe, comptees comme personnes. */
  staffVotes: number;
  score: number;
  /** `true` des que le score atteint le seuil d'adoption. */
  adopted: boolean;
  /** Voix manquantes avant l'adoption, deja calculees par le serveur. */
  scoreToAdoption: number;
  /**
   * Libelle d'auteur. Toujours `null` aujourd'hui : le serveur refuse de le
   * prendre depuis la requete, un libelle libre permettrait de se faire passer
   * pour l'equipe. Le champ reste pour une valeur derivee du compte.
   */
  authorLabel: string | null;
  isMine: boolean;
  myVote: -1 | 0 | 1;
  createdAt: string;
}

export interface MediaSegmentsResponse {
  found: boolean;
  segments: MediaSegment[];
  providerStatus: Record<string, ProviderStatus>;
  /** Detail technique par source (code HTTP), pour l'infobulle des reglages. */
  providerDetail: Record<string, string>;
  imdbId: string | null;
  malId: number | null;
  /** Propositions de la communaute, adoptees ou en attente de voix. */
  community: CommunitySubmission[];
  /** Score requis pour qu'une proposition devienne un vrai saut. */
  adoptionScore: number;
  /** `false` quand la session n'est pas connectee : lecture seule. */
  canContribute: boolean;
  /** Poids de la voix du lecteur : 3 pour l'equipe, 1 sinon. */
  voteWeight: number;
  degraded?: boolean;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  supportsMovies: boolean;
  /** `false` quand le serveur n'a pas la cle d'API requise. */
  configured: boolean;
}

const EMPTY: MediaSegmentsResponse = {
  found: false,
  segments: [],
  providerStatus: {},
  providerDetail: {},
  imdbId: null,
  malId: null,
  community: [],
  adoptionScore: 3,
  canContribute: false,
  voteWeight: 1,
};

const segmentsApi = axios.create({
  baseURL: `${MAIN_API}/api/segments`,
  timeout: 15000,
});

/**
 * Le jeton est envoye meme en lecture : c'est lui qui permet au serveur de
 * renvoyer `myVote` sur chaque proposition et de dire si la session peut
 * contribuer. Sans jeton, la lecture fonctionne, en anonyme.
 */
function authHeaders(): Record<string, string> | undefined {
  try {
    const token = localStorage.getItem('auth_token');
    return token ? { Authorization: `Bearer ${token}` } : undefined;
  } catch {
    return undefined;
  }
}

// Cache de session + deduplication des requetes concurrentes. Le lecteur est
// remonte a chaque changement de source (prop `key`) : sans ca, revenir a un
// hoster deja essaye sur le meme episode relancerait un appel identique.
const cache = new Map<string, MediaSegmentsResponse>();
const inflight = new Map<string, Promise<MediaSegmentsResponse>>();

/**
 * La duree fait partie de la requete : c'est elle qui permet aux fournisseurs
 * de recaler leurs horodatages. Arrondie a la seconde, sinon deux lectures de
 * la meme source (1440.02 puis 1440.11) creeraient deux entrees pour rien.
 */
export function roundDuration(duration: number): number {
  return Math.round(duration);
}

interface FetchArgs {
  mediaType: 'tv' | 'movie';
  tmdbId: string | number;
  season?: number | null;
  episode?: number | null;
  duration: number;
  signal?: AbortSignal;
}

export async function fetchMediaSegments({
  mediaType,
  tmdbId,
  season = null,
  episode = null,
  duration,
  signal,
}: FetchArgs): Promise<MediaSegmentsResponse> {
  if (!tmdbId || !Number.isFinite(duration) || duration <= 0) return EMPTY;
  if (mediaType === 'tv' && (!Number.isFinite(Number(season)) || !Number.isFinite(Number(episode)))) {
    return EMPTY;
  }

  const durationSec = roundDuration(duration);
  const key = `${mediaType}:${tmdbId}:${season ?? '-'}:${episode ?? '-'}:${durationSec}`;

  const cached = cache.get(key);
  if (cached) return cached;

  const pending = inflight.get(key);
  if (pending) return pending;

  const params: Record<string, number | string> = { duration: durationSec };
  if (mediaType === 'tv') {
    params.season = Number(season);
    params.episode = Number(episode);
  }

  const request = segmentsApi
    .get<MediaSegmentsResponse>(`/${mediaType}/${tmdbId}`, { params, signal, headers: authHeaders() })
    .then((res) => {
      const data = res.data;
      const normalized: MediaSegmentsResponse = {
        found: Boolean(data?.found),
        segments: Array.isArray(data?.segments) ? data.segments : [],
        providerStatus: data?.providerStatus ?? {},
        providerDetail: data?.providerDetail ?? {},
        imdbId: data?.imdbId ?? null,
        malId: data?.malId ?? null,
        community: Array.isArray(data?.community) ? data.community : [],
        adoptionScore: Number.isFinite(Number(data?.adoptionScore)) ? Number(data.adoptionScore) : 3,
        canContribute: Boolean(data?.canContribute),
        voteWeight: Number.isFinite(Number(data?.voteWeight)) ? Number(data.voteWeight) : 1,
        degraded: data?.degraded,
      };
      // Un echec upstream (`degraded`) n'est pas mis en cache : changer de
      // source ou d'episode doit pouvoir reessayer.
      if (!normalized.degraded) cache.set(key, normalized);
      return normalized;
    })
    .catch(() => EMPTY)
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, request);
  return request;
}

let providersPromise: Promise<ProviderInfo[]> | null = null;

/** Inventaire des fournisseurs cote serveur, pour l'ecran de reglages. */
export function fetchProviders(): Promise<ProviderInfo[]> {
  if (!providersPromise) {
    providersPromise = segmentsApi
      .get<{ providers: ProviderInfo[] }>('/providers')
      .then((res) => (Array.isArray(res.data?.providers) ? res.data.providers : []))
      .catch(() => {
        // Un echec ne doit pas figer la liste : la prochaine ouverture des
        // reglages reessaie.
        providersPromise = null;
        return [];
      });
  }
  return providersPromise;
}

/**
 * Dernier garde-fou cote client.
 *
 * Le gros du travail (recalage, comparaison a la duree de reference) a deja eu
 * lieu cote serveur, qui connait la duree exacte transmise. Il reste a se
 * proteger des cas ou la duree a bouge entre la requete et la lecture —
 * changement de source, flux qui se rallonge en cours de chargement.
 */
export function validateSegments(segments: MediaSegment[], actualDuration: number): MediaSegment[] {
  if (!Array.isArray(segments) || segments.length === 0) return [];
  if (!Number.isFinite(actualDuration) || actualDuration <= 0) return [];

  return segments.filter(
    (segment) =>
      Number.isFinite(segment.start) &&
      Number.isFinite(segment.end) &&
      segment.start >= 0 &&
      segment.end > segment.start &&
      // Un segment qui deborde de la video vient forcement d'un mauvais
      // mapping : on le jette plutot que de le rogner.
      segment.end <= actualDuration + 1,
  );
}

interface CommunityTarget {
  mediaType: 'tv' | 'movie';
  tmdbId: string | number;
  season?: number | null;
  episode?: number | null;
  durationMs: number;
}

/**
 * Oublie l'entree de cache d'un contenu.
 *
 * Le cache de session evite de redemander les memes segments a chaque
 * changement de hoster, mais il retiendrait aussi un score de vote perime :
 * apres avoir vote ou depose une proposition, on l'invalide pour que le
 * prochain chargement reparte du serveur.
 */
export function invalidateSegments(target: CommunityTarget): void {
  const durationSec = roundDuration(target.durationMs / 1000);
  const key = `${target.mediaType}:${target.tmdbId}:${target.season ?? '-'}:${target.episode ?? '-'}:${durationSec}`;
  cache.delete(key);
}

/** Depose ou remplace sa proposition pour ce type de sequence. */
export async function submitCommunitySegment(payload: {
  mediaType: 'tv' | 'movie';
  tmdbId: string | number;
  season?: number | null;
  episode?: number | null;
  segmentType: SegmentKind;
  startMs: number;
  endMs: number;
  durationMs: number;
}): Promise<CommunitySubmission> {
  const res = await segmentsApi.post<{ submission: CommunitySubmission }>(
    '/community',
    payload,
    { headers: authHeaders() },
  );
  return res.data.submission;
}

/**
 * Vote sur une proposition. `0` retire son vote.
 *
 * `deleted` vaut `true` quand le vote a fait passer le score sous le seuil de
 * rejet : la proposition n'existe plus, l'appelant doit la retirer de son etat.
 */
export async function voteCommunitySegment(
  submissionId: string,
  value: 1 | -1 | 0,
): Promise<{ deleted: boolean; submission: CommunitySubmission | null }> {
  const res = await segmentsApi.post<{ deleted: boolean; submission: CommunitySubmission | null }>(
    `/community/${submissionId}/vote`,
    { value },
    { headers: authHeaders() },
  );
  return res.data;
}

/**
 * Extrait le code d'erreur renvoye par l'API communautaire.
 *
 * Les echecs de vote etaient jusqu'ici avales dans la console : l'utilisateur
 * cliquait, rien ne bougeait, et rien ne disait pourquoi. Le code remonte
 * jusqu'a la carte pour y etre traduit.
 */
export function extractCommunityErrorCode(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const code = error.response?.data?.error;
    if (typeof code === 'string' && code) return code;
    if (error.response?.status === 401) return 'unauthorized';
  }
  return 'unknown';
}

/** Retire sa propre proposition. */
export async function deleteCommunitySegment(submissionId: string): Promise<void> {
  await segmentsApi.delete(`/community/${submissionId}`, { headers: authHeaders() });
}

/** Motifs proposés sur la carte de vote, dans l'ordre d'affichage. */
export const SEGMENT_REPORT_REASONS = ['wrong_timestamp', 'spam', 'other'] as const;
export type SegmentReportReason = (typeof SEGMENT_REPORT_REASONS)[number];

/**
 * Signale une proposition à la modération.
 *
 * Passe volontairement par `/api/comments/report`, la file de signalements
 * commune : c'est elle qu'affiche le panneau d'administration, avec ses états
 * (en attente / traité / rejeté) et ses notifications au signaleur. Une file
 * séparée aurait demandé un deuxième écran pour la même décision.
 *
 * Le serveur refuse un deuxième signalement du même compte sur la même
 * proposition (409) : c'est un succès du point de vue de l'utilisateur, la
 * carte l'affiche comme tel.
 */
export async function reportCommunitySegment(
  submissionId: string,
  reason: SegmentReportReason,
): Promise<void> {
  let profileId: string | null = null;
  try {
    profileId = localStorage.getItem('selected_profile_id');
  } catch {
    profileId = null;
  }

  try {
    await axios.post(
      `${MAIN_API}/api/comments/report`,
      { targetType: 'segment', targetId: submissionId, reason, profileId },
      { headers: authHeaders(), timeout: 15000 },
    );
  } catch (error) {
    // Déjà signalé : le but est atteint, inutile d'afficher une erreur.
    if (axios.isAxiosError(error) && error.response?.status === 409) return;
    throw error;
  }
}

/** Vide le cache de session (tests, panneau de debug). */
export function clearSegmentsCache(): void {
  cache.clear();
  inflight.clear();
  providersPromise = null;
}
