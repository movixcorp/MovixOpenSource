// src/utils/segmentContribSites.ts
//
// Où aller déposer un relevé chez les bases externes.
//
// Movix ne réenvoie rien à leur place : ces quatre bases ont leurs propres
// règles, leurs propres comptes et leurs propres modérateurs, et un relais
// côté serveur ferait passer toutes les contributions pour celles d'un seul
// compte Movix. On envoie donc l'utilisateur chez elles, avec son relevé déjà
// copié dans le presse-papier — c'est lui le contributeur, pas nous.
//
// Les liens profonds sont construits à partir des identifiants que la réponse
// `/api/segments` renvoie déjà (`imdbId`, `malId`) : on tombe directement sur
// la fiche du titre plutôt que sur une page d'accueil.

import type { ProviderId, SegmentKind } from './skipSegmentPrefs';

/**
 * Raison pour laquelle une base ne peut rien faire de ce relevé.
 *
 * `media`  — elle n'indexe pas ce genre de contenu (film chez une base séries).
 * `type`   — elle ne connaît pas ce type de séquence.
 * `id`     — il manque l'identifiant sans lequel elle ne saurait pas de quoi
 *            on parle (IMDb, MyAnimeList).
 */
export type ContribBlockReason = 'media' | 'type' | 'id';

export interface ContribSite {
  id: ProviderId;
  label: string;
  /** Ce qu'on ouvre quand aucun lien profond n'est possible. */
  home: string;
  supportsMovies: boolean;
  supportsSeries: boolean;
  /** Types de séquence que la base sait recevoir. */
  segmentTypes: readonly SegmentKind[];
  /** Identifiant requis pour que la contribution ait un sens. */
  needs: 'imdbId' | 'malId' | null;
  /** Construit le lien profond ; `null` quand l'identifiant manque. */
  deepLink?: (ctx: ContribContext) => string | null;
}

export interface ContribContext {
  mediaType: 'tv' | 'movie';
  imdbId: string | null;
  malId: number | null;
  segmentType: SegmentKind;
}

/**
 * Les quatre bases, dans l'ordre où elles sont les plus utiles à Movix :
 * SkipDB et IntroDB acceptent n'importe quel titre indexé IMDb, TheIntroDB
 * demande un compte, AniSkip ne couvre que les animés.
 */
export const CONTRIB_SITES: readonly ContribSite[] = [
  {
    id: 'skipdb',
    label: 'SkipDB',
    home: 'https://skipdb.tv/search',
    supportsMovies: true,
    supportsSeries: true,
    // Pas de `credits` : SkipDB range tout ce qui suit l'épisode dans `outro`.
    segmentTypes: ['intro', 'recap', 'outro', 'preview'],
    needs: null,
    deepLink: ({ imdbId }) => (imdbId ? `https://skipdb.tv/title/${imdbId}` : null),
  },
  {
    id: 'introdb',
    label: 'IntroDB',
    home: 'https://introdb.app/shows',
    supportsMovies: false,
    supportsSeries: true,
    segmentTypes: ['intro', 'recap', 'outro'],
    needs: null,
    deepLink: ({ imdbId }) => (imdbId ? `https://introdb.app/shows/${imdbId}` : null),
  },
  {
    id: 'theintrodb',
    label: 'TheIntroDB',
    // Application monopage sans route publique stable : on ouvre l'accueil et
    // c'est l'utilisateur qui cherche son titre.
    home: 'https://theintrodb.org/',
    supportsMovies: true,
    supportsSeries: true,
    segmentTypes: ['intro', 'recap', 'outro', 'credits', 'preview'],
    needs: null,
  },
  {
    id: 'aniskip',
    label: 'AniSkip',
    // AniSkip ne se contribue pas depuis un site : tout passe par son
    // extension de navigateur, dont le dépôt liste les deux magasins.
    home: 'https://github.com/aniskip/aniskip-extension',
    supportsMovies: false,
    supportsSeries: true,
    segmentTypes: ['intro', 'recap', 'outro'],
    // Sans identifiant MyAnimeList, le contenu n'est pas un animé connu
    // d'AniSkip : proposer le lien ferait perdre son temps à l'utilisateur.
    needs: 'malId',
  },
];

/** Première raison qui empêche cette base de recevoir ce relevé, ou `null`. */
export function getContribBlockReason(
  site: ContribSite,
  ctx: ContribContext,
): ContribBlockReason | null {
  if (ctx.mediaType === 'movie' && !site.supportsMovies) return 'media';
  if (ctx.mediaType === 'tv' && !site.supportsSeries) return 'media';
  if (!site.segmentTypes.includes(ctx.segmentType)) return 'type';
  if (site.needs === 'imdbId' && !ctx.imdbId) return 'id';
  if (site.needs === 'malId' && !ctx.malId) return 'id';
  return null;
}

/** Lien à ouvrir : la fiche du titre si on sait la construire, sinon l'accueil. */
export function getContribUrl(site: ContribSite, ctx: ContribContext): string {
  return site.deepLink?.(ctx) ?? site.home;
}

/** `h:mm:ss.mmm`, la même écriture que les bornes du studio. */
function formatBoundary(totalMs: number): string {
  const clamped = Math.max(0, Math.round(totalMs));
  const ms = clamped % 1000;
  const totalSeconds = Math.floor(clamped / 1000);
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  return [
    `${Math.floor(totalSeconds / 3600)}`,
    pad(Math.floor(totalSeconds / 60) % 60),
    `${pad(totalSeconds % 60)}.${pad(ms, 3)}`,
  ].join(':');
}

/**
 * Relevé prêt à coller dans le formulaire de la base visée.
 *
 * Chaque base attend un format différent (secondes, millisecondes, horloge) :
 * on donne les trois plutôt que de parier sur le bon, et l'identifiant du
 * titre avec, puisque c'est la première chose que leurs formulaires demandent.
 */
export function formatContribClipboard(input: {
  segmentType: SegmentKind;
  startMs: number;
  endMs: number;
  season: number | null;
  episode: number | null;
  imdbId: string | null;
  malId: number | null;
}): string {
  const lines = [
    `${input.segmentType}  ${formatBoundary(input.startMs)} → ${formatBoundary(input.endMs)}`,
    `ms: ${Math.round(input.startMs)} → ${Math.round(input.endMs)}`,
    `s:  ${(input.startMs / 1000).toFixed(3)} → ${(input.endMs / 1000).toFixed(3)}`,
  ];
  if (input.season !== null && input.episode !== null) {
    lines.push(`S${String(input.season).padStart(2, '0')}E${String(input.episode).padStart(2, '0')}`);
  }
  if (input.imdbId) lines.push(`IMDb: ${input.imdbId}`);
  if (input.malId) lines.push(`MAL: ${input.malId}`);
  return lines.join('\n');
}
