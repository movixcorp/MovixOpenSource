import { dedupeByUrl, sortTracks } from './filtering.ts';
import { opensubtitlesLegacyProvider } from './opensubtitlesLegacy.ts';
import { sheguProvider } from './shegu.ts';
import type { SubtitleProvider, SubtitleQuery, SubtitleTrack } from './types.ts';

export * from './types.ts';
export * from './filtering.ts';
export { sheguProvider } from './shegu.ts';
export { opensubtitlesLegacyProvider } from './opensubtitlesLegacy.ts';

export interface ProviderError {
  provider: string;
  message: string;
}

export interface SearchAllResult {
  tracks: SubtitleTrack[];
  errors: ProviderError[];
}

export interface SearchAllOptions {
  /** Injectable pour les tests. Par defaut : SUBTITLE_PROVIDERS. */
  providers?: readonly SubtitleProvider[];
  /** Langue remontee en tete du tri. Passee explicitement pour que le
   *  registre reste testable hors contexte React / i18n. */
  preferredLang?: string;
}

export const SUBTITLE_PROVIDERS: readonly SubtitleProvider[] = [
  sheguProvider,
  opensubtitlesLegacyProvider,
];

/**
 * Interroge tous les providers en parallele. Un provider en echec n'empeche
 * jamais les autres de repondre : son erreur est collectee et remontee pour
 * affichage discret, plutot que de produire un etat vide trompeur.
 */
export async function searchAll(
  query: SubtitleQuery,
  signal: AbortSignal,
  options: SearchAllOptions = {},
): Promise<SearchAllResult> {
  const providers = options.providers ?? SUBTITLE_PROVIDERS;
  const preferredLang = options.preferredLang ?? '';

  const settled = await Promise.allSettled(
    providers.map(provider => provider.search(query, signal)),
  );

  const tracks: SubtitleTrack[] = [];
  const errors: ProviderError[] = [];

  settled.forEach((outcome, index) => {
    const provider = providers[index];
    if (outcome.status === 'fulfilled') {
      // Vérifier que outcome.value est bien un tableau avant d'utiliser le spread.
      // Le contrat SubtitleTrack[] n'est garanti qu'au typage, pas à l'exécution.
      // Un bug dans un futur provider pourrait retourner undefined, null, ou un objet.
      // Sans ce garde-fou, le spread sur une non-itérable lèverait une TypeError synchrone
      // qui rejetterait la promesse entière et perdrait tous les résultats collectés des
      // autres providers. Ce contrôle la traite comme toute autre défaillance.
      if (Array.isArray(outcome.value)) {
        tracks.push(...outcome.value);
      } else {
        errors.push({
          provider: provider.id,
          message: 'provider returned a non-array result',
        });
      }
      return;
    }
    const reason = outcome.reason;
    errors.push({
      provider: provider.id,
      message: reason instanceof Error ? reason.message : String(reason),
    });
  });

  return { tracks: sortTracks(dedupeByUrl(tracks), preferredLang), errors };
}
