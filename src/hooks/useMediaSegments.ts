// src/hooks/useMediaSegments.ts
//
// Charge les segments (intro / resume / outro / credits / apercu) du contenu en
// cours, les retaille selon les reglages de l'utilisateur, et expose celui qui
// couvre `currentTime`.
//
// Deux garanties tenues ici :
//
//  1. Le hook ne touche JAMAIS a l'element <video>. C'est l'appelant qui saute
//     (mode `auto`) ou affiche un bouton (mode `button`), ce qui garde toute la
//     logique de saut au meme endroit que la synchro watch party.
//
//  2. Rien n'est demande avant que la lecture soit reellement lancee (reglage
//     `deferLoading`, actif par defaut), plus un court delai d'inactivite. Le
//     chargement du manifeste HLS et des premiers fragments ne doit pas se
//     disputer la bande passante avec quatre bases communautaires — et surtout,
//     le lecteur ne doit rien attendre d'elles pour demarrer.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchMediaSegments,
  invalidateSegments,
  roundDuration,
  validateSegments,
  type CommunitySubmission,
  type MediaSegment,
  type ProviderStatus,
} from '../services/mediaSegmentsService';
import { applyProviderPreferences, mergeTrustedProposals } from '../utils/segmentConsensus';
import {
  SKIP_PREFS_CHANGE_EVENT,
  getSkipSettings,
  hasAnyActiveSegmentKind,
  resolveSegmentMode,
  type SkipMode,
  type SkipSegmentSettings,
} from '../utils/skipSegmentPrefs';

/** Laisse retomber l'activite reseau du demarrage avant d'interroger le backend. */
const IDLE_DELAY_MS = 900;

interface UseMediaSegmentsOptions {
  /** Id TMDB de la serie, quand on regarde un episode. */
  tvShowId?: string | number;
  /** Id TMDB du film, quand on regarde un film. */
  movieId?: string | number;
  seasonNumber?: number;
  episodeNumber?: number;
  /** Duree reelle de la source jouee, en secondes. 0 tant qu'elle est inconnue. */
  duration: number;
  currentTime: number;
  /** La lecture a-t-elle demarre au moins une fois ? Voir `deferLoading`. */
  playbackStarted: boolean;
  /** Coupe totalement la fonctionnalite (invite de watch party, direct, ...). */
  enabled?: boolean;
}

interface UseMediaSegmentsResult {
  /** Segments a afficher dans la barre de progression. */
  segments: MediaSegment[];
  /** Segment couvrant `currentTime`, si son type est actif. */
  activeSegment: MediaSegment | null;
  /** Mode effectif du segment actif (`off` quand il n'y en a pas). */
  activeMode: SkipMode;
  /** Le bouton doit-il etre affiche maintenant (delai d'apparition ecoule) ? */
  promptVisible: boolean;
  settings: SkipSegmentSettings;
  loading: boolean;
  providerStatus: Record<string, ProviderStatus>;
  providerDetail: Record<string, string>;
  /** Propositions de la communaute, adoptees ou en attente de voix. */
  community: CommunitySubmission[];
  /** Score requis pour qu'une proposition devienne un vrai saut. */
  adoptionScore: number;
  /** `false` quand la session n'est pas connectee : lecture seule. */
  canContribute: boolean;
  /** Poids de la voix du lecteur : 3 pour l'equipe, 1 sinon. */
  voteWeight: number;
  /**
   * Identifiant IMDb du contenu, resolu par le serveur. Sert a construire les
   * liens vers les fiches des bases externes (`utils/segmentContribSites.ts`).
   */
  imdbId: string | null;
  /** Identifiant MyAnimeList, quand le contenu est un anime connu d'AniSkip. */
  malId: number | null;
  /** Identifiants du contenu en cours, pour deposer une proposition. */
  target: { mediaType: 'tv' | 'movie'; tmdbId: string | number; season: number | null; episode: number | null } | null;
  /** Redemande tout au serveur, apres un vote ou un depot. */
  refresh: () => void;
}

const EMPTY_SEGMENTS: MediaSegment[] = [];
const EMPTY_STATUS: Record<string, ProviderStatus> = {};
const EMPTY_DETAIL: Record<string, string> = {};
const EMPTY_COMMUNITY: CommunitySubmission[] = [];

/** Relit les reglages a chaque changement (panneau du lecteur, autre onglet). */
function useSkipSettings(): SkipSegmentSettings {
  const [settings, setSettings] = useState<SkipSegmentSettings>(() => getSkipSettings());

  useEffect(() => {
    const reload = () => setSettings(getSkipSettings());
    window.addEventListener(SKIP_PREFS_CHANGE_EVENT, reload);
    window.addEventListener('storage', reload);
    return () => {
      window.removeEventListener(SKIP_PREFS_CHANGE_EVENT, reload);
      window.removeEventListener('storage', reload);
    };
  }, []);

  return settings;
}

export function useMediaSegments({
  tvShowId,
  movieId,
  seasonNumber,
  episodeNumber,
  duration,
  currentTime,
  playbackStarted,
  enabled = true,
}: UseMediaSegmentsOptions): UseMediaSegmentsResult {
  const [rawSegments, setRawSegments] = useState<MediaSegment[]>(EMPTY_SEGMENTS);
  const [providerStatus, setProviderStatus] = useState<Record<string, ProviderStatus>>(EMPTY_STATUS);
  const [providerDetail, setProviderDetail] = useState<Record<string, string>>(EMPTY_DETAIL);
  const [community, setCommunity] = useState<CommunitySubmission[]>(EMPTY_COMMUNITY);
  const [adoptionScore, setAdoptionScore] = useState(3);
  const [canContribute, setCanContribute] = useState(false);
  const [voteWeight, setVoteWeight] = useState(1);
  const [imdbId, setImdbId] = useState<string | null>(null);
  const [malId, setMalId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  // Incremente pour forcer un rechargement a cle inchangee, apres un vote.
  const [refreshToken, setRefreshToken] = useState(0);

  const settings = useSkipSettings();

  const mediaType: 'tv' | 'movie' | null = tvShowId ? 'tv' : movieId ? 'movie' : null;
  const tmdbId = tvShowId ?? movieId;

  // La duree fait partie de la requete : sans elle, aucun fournisseur ne peut
  // recaler ses horodatages et le backend ne peut rien valider.
  const durationSec = Number.isFinite(duration) && duration > 0 ? roundDuration(duration) : 0;

  const active =
    enabled &&
    settings.mode !== 'off' &&
    hasAnyActiveSegmentKind(settings) &&
    settings.enabledProviders.length > 0 &&
    (playbackStarted || !settings.deferLoading);

  const requestKey =
    active && mediaType && tmdbId && durationSec > 0 &&
    (mediaType === 'movie' || (seasonNumber != null && episodeNumber != null))
      ? `${mediaType}:${tmdbId}:${seasonNumber ?? '-'}:${episodeNumber ?? '-'}:${durationSec}`
      : null;

  // Les arguments de la requete passent par une ref : l'effet ne depend que de
  // `requestKey`, qui les encapsule tous. Sans ca, un simple changement de
  // reglage (qui recalcule `active`) rejouerait l'effet, dont le nettoyage
  // annulerait la requete en vol — et comme la cle n'aurait pas bouge, aucune
  // nouvelle requete ne partirait : les segments n'arriveraient jamais.
  const fetchArgsRef = useRef({ mediaType, tmdbId, seasonNumber, episodeNumber, durationSec });
  fetchArgsRef.current = { mediaType, tmdbId, seasonNumber, episodeNumber, durationSec };

  useEffect(() => {
    if (!active) {
      setRawSegments(EMPTY_SEGMENTS);
      setProviderStatus(EMPTY_STATUS);
      setProviderDetail(EMPTY_DETAIL);
      setImdbId(null);
      setMalId(null);
      return;
    }
    // Requete simplement differee (lecture pas encore lancee) : ne rien vider,
    // sinon les marqueurs clignoteraient.
    if (!requestKey) return;

    const args = fetchArgsRef.current;
    const controller = new AbortController();
    let cancelled = false;

    setLoading(true);
    setRawSegments(EMPTY_SEGMENTS);
    setProviderStatus(EMPTY_STATUS);
    setProviderDetail(EMPTY_DETAIL);
    // Les identifiants aussi : garder ceux du contenu precedent ferait pointer
    // les liens du studio vers la mauvaise fiche le temps de la requete.
    setImdbId(null);
    setMalId(null);

    // Delai d'inactivite : le lecteur vient de demarrer, on lui laisse la
    // bande passante. Annule si l'utilisateur change d'episode entre-temps.
    const timer = setTimeout(() => {
      fetchMediaSegments({
        mediaType: args.mediaType!,
        tmdbId: args.tmdbId!,
        season: args.mediaType === 'tv' ? Number(args.seasonNumber) : null,
        episode: args.mediaType === 'tv' ? Number(args.episodeNumber) : null,
        duration: args.durationSec,
        signal: controller.signal,
      })
        .then((response) => {
          if (cancelled) return;
          setRawSegments(response.segments);
          setProviderStatus(response.providerStatus);
          setProviderDetail(response.providerDetail);
          setCommunity(response.community);
          setAdoptionScore(response.adoptionScore);
          setCanContribute(response.canContribute);
          setVoteWeight(response.voteWeight);
          setImdbId(response.imdbId);
          setMalId(response.malId);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, IDLE_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
    // `requestKey` encapsule deja mediaType / tmdbId / saison / episode / duree :
    // les remettre en dependances rejouerait l'effet sans qu'il y ait quoi que
    // ce soit de nouveau a demander. `refreshToken` est le seul moyen de
    // relancer volontairement a cle identique.
  }, [requestKey, active, refreshToken]);

  // Retaillage selon les fournisseurs autorises et les seuils, puis garde-fou
  // final : la duree a pu bouger entre la requete et la lecture.
  const segments = useMemo(() => {
    const preferred = applyProviderPreferences(rawSegments, settings, duration);
    // Les propositions en attente ne deviennent de vraies sequences que si
    // l'utilisateur a explicitement choisi de leur faire confiance.
    const withTrusted = settings.trustPendingProposals
      ? mergeTrustedProposals(preferred, community, settings, duration)
      : preferred;
    const bounded = validateSegments(withTrusted, duration);
    // Un type coupe ne merite ni bouton ni marqueur.
    return bounded.filter((segment) => resolveSegmentMode(settings, segment.type) !== 'off');
  }, [rawSegments, community, settings, duration]);

  const activeSegment = useMemo(() => {
    if (segments.length === 0 || !Number.isFinite(currentTime)) return null;
    return segments.find((segment) => currentTime >= segment.start && currentTime < segment.end) ?? null;
  }, [segments, currentTime]);

  const activeMode: SkipMode = activeSegment ? resolveSegmentMode(settings, activeSegment.type) : 'off';

  const promptVisible =
    activeMode === 'button' &&
    activeSegment !== null &&
    currentTime >= activeSegment.start + settings.promptDelay;

  const target = useMemo(() => {
    if (!mediaType || !tmdbId) return null;
    return {
      mediaType,
      tmdbId,
      season: mediaType === 'tv' ? Number(seasonNumber) : null,
      episode: mediaType === 'tv' ? Number(episodeNumber) : null,
    };
  }, [mediaType, tmdbId, seasonNumber, episodeNumber]);

  const refresh = useCallback(() => {
    const args = fetchArgsRef.current;
    if (args.mediaType && args.tmdbId && args.durationSec > 0) {
      // Purge l'entree de session, sinon le rechargement reservirait le meme
      // score de vote.
      invalidateSegments({
        mediaType: args.mediaType,
        tmdbId: args.tmdbId,
        season: args.mediaType === 'tv' ? Number(args.seasonNumber) : null,
        episode: args.mediaType === 'tv' ? Number(args.episodeNumber) : null,
        durationMs: args.durationSec * 1000,
      });
    }
    setRefreshToken((value) => value + 1);
  }, []);

  return {
    segments, activeSegment, activeMode, promptVisible, settings, loading,
    providerStatus, providerDetail,
    community, adoptionScore, canContribute, voteWeight, imdbId, malId, target, refresh,
  };
}

export default useMediaSegments;
