/**
 * Les personnages d'une fiche, quelle que soit son origine.
 *
 * Deux sources, une seule forme en sortie, pour que la section d'affichage
 * n'ait pas à savoir d'où vient ce qu'elle montre :
 *
 *  - **AniList** pour l'animation japonaise. Elle rend les personnages
 *    eux-mêmes — illustration, rôle, voix japonaise — là où TMDB ne rend que
 *    des comédiens.
 *  - **TMDB** pour tout le reste. Le rôle devient le titre de la carte et le
 *    comédien le sous-titre : c'est le personnage qu'on cherche à reconnaître,
 *    la fiche a déjà un onglet Distribution pour l'inverse.
 *
 * AniList est tentée dès que l'œuvre en a le profil, films compris — un
 * long-métrage Ghibli y est aussi bien décrit qu'une série. Si elle ne rend
 * rien, on retombe sur TMDB : mieux vaut des comédiens que rien.
 */

import { encodeId } from '../utils/idEncoder';
import { findAnilistMedia, type AnilistMedia } from './anilistService';

const TMDB_PROFILE_BASE = 'https://image.tmdb.org/t/p';

/**
 * Personnages retenus depuis TMDB. Au-delà, on descend dans les silhouettes non
 * créditées à l'écran, qui n'apprennent rien et alourdissent la page.
 */
const MAX_TMDB_CHARACTERS = 36;

/** Les figurants d'AniList : présents dans la base, absents de l'écran. */
const ANILIST_ROLES_SHOWN = new Set(['MAIN', 'SUPPORTING']);

export interface DetailCharacter {
  key: string;
  /** Ce qu'on lit en gros : le nom du personnage. */
  name: string;
  imageUrl?: string;
  /** Qui l'interprète ou le double. */
  performer?: string;
  /** Fiche Movix de l'interprète, quand elle existe. */
  href?: string;
}

export interface DetailCharacterGroup {
  /** `null` quand la source ne distingue pas les rôles : pas d'intertitre. */
  role: 'main' | 'supporting' | null;
  characters: DetailCharacter[];
}

export interface DetailCharacters {
  source: 'anilist' | 'tmdb';
  /** Décide du libellé sous chaque nom : « Seiyū » ou « Avec ». */
  performerKind: 'seiyu' | 'actor';
  groups: DetailCharacterGroup[];
  total: number;
  /** Thèmes AniList, absents quand les personnages viennent de TMDB. */
  themes: string[];
  /** Titres connus d'AniList, à réunir avec ceux de TMDB. */
  alternateTitles: string[];
}

export interface TmdbCastMember {
  id: number;
  name: string;
  character?: string;
  profile_path?: string | null;
}

const fromAnilist = (media: AnilistMedia): DetailCharacters => {
  const shown = media.characters.filter((character) => ANILIST_ROLES_SHOWN.has(character.role));

  const build = (role: 'main' | 'supporting'): DetailCharacterGroup => ({
    role,
    characters: shown
      .filter((character) => character.role === (role === 'main' ? 'MAIN' : 'SUPPORTING'))
      .map((character) => ({
        key: `anilist:${character.id}`,
        name: character.name,
        imageUrl: character.imageUrl,
        performer: character.voiceActor,
      })),
  });

  const groups = [build('main'), build('supporting')].filter((group) => group.characters.length > 0);

  return {
    source: 'anilist',
    performerKind: 'seiyu',
    groups,
    total: shown.length,
    themes: media.themes.map((theme) => theme.name),
    alternateTitles: media.titles,
  };
};

const fromTmdb = (cast: TmdbCastMember[]): DetailCharacters => {
  const characters = cast
    .filter((member) => member?.id && (member.character || member.name))
    .slice(0, MAX_TMDB_CHARACTERS)
    .map((member) => ({
      key: `tmdb:${member.id}:${member.character || ''}`,
      // Sans nom de rôle — voix, caméo, non crédité — le comédien reprend la
      // vedette : une carte « Personnage inconnu » n'apprendrait rien.
      name: member.character?.trim() || member.name,
      imageUrl: member.profile_path ? `${TMDB_PROFILE_BASE}/w185${member.profile_path}` : undefined,
      performer: member.character?.trim() ? member.name : undefined,
      href: `/person/${encodeId(member.id)}`,
    }));

  return {
    source: 'tmdb',
    performerKind: 'actor',
    // TMDB classe par ordre d'apparition au générique, sans dire où s'arrêtent
    // les rôles principaux. Inventer une coupure tromperait ; on garde l'ordre
    // du générique, sans intertitre.
    groups: characters.length > 0 ? [{ role: null, characters }] : [],
    total: characters.length,
    themes: [],
    alternateTitles: [],
  };
};

export interface LoadCharactersOptions {
  /** Titres à essayer sur AniList, du plus prometteur au moins. */
  anilistTitles: string[];
  /** L'œuvre a-t-elle le profil d'un anime ? Décide si AniList est tentée. */
  looksLikeAnime: boolean;
  /** Distribution TMDB, déjà chargée par la fiche. */
  cast: TmdbCastMember[];
}

/**
 * Les personnages à afficher. Rend `null` quand aucune source ne donne rien —
 * la fiche omet alors la section plutôt que d'afficher un cadre vide.
 */
export const loadDetailCharacters = async (
  options: LoadCharactersOptions,
): Promise<DetailCharacters | null> => {
  if (options.looksLikeAnime) {
    const media = await findAnilistMedia(options.anilistTitles);
    if (media) {
      const built = fromAnilist(media);
      // AniList connaît l'œuvre mais pas ses personnages : ses thèmes et ses
      // titres restent bons à prendre, les cartes viennent de TMDB.
      if (built.total > 0) return built;

      const fallback = fromTmdb(options.cast);
      return fallback.total > 0
        ? { ...fallback, themes: built.themes, alternateTitles: built.alternateTitles }
        : built.themes.length > 0 || built.alternateTitles.length > 0 ? built : null;
    }
  }

  const built = fromTmdb(options.cast);
  return built.total > 0 ? built : null;
};
