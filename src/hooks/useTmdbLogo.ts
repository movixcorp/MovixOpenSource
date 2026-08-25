// Thin re-export — la logique vit désormais dans useTmdbImages qui retourne
// aussi le posterUrl localisé (1 fetch TMDB pour les deux). Garde ce
// fichier pour rétrocompatibilité d'éventuels imports externes.
export { useTmdbLogo } from './useTmdbImages';
