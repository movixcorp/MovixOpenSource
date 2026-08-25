import type { CalendarCategory } from '../../types/calendar';

interface CategoryAccent {
  /** Pastille pleine, pour les puces et la légende. */
  dot: string;
  /** Fond teinté, pour les filtres et le sélecteur du formulaire. */
  chip: string;
  /** Anneau de sélection. */
  ring: string;
  /**
   * Puce compacte des cases du calendrier. Teintée par catégorie plutôt que
   * grise : sur une grille de 42 cases, la couleur porte l'information bien
   * mieux qu'un point de 6 pixels.
   */
  cell: string;
}

/** Ordre d'affichage, partagé par les filtres, la légende et le formulaire. */
export const CALENDAR_CATEGORIES: CalendarCategory[] = ['movie', 'tv', 'anime', 'documentary', 'other'];

/**
 * Teinte de chaque catégorie. Une seule table, partagée par la grille,
 * l'agenda, les filtres et le formulaire — sans quoi la même catégorie
 * finirait par ne pas avoir la même couleur d'un écran à l'autre.
 */
export const CATEGORY_ACCENT: Record<CalendarCategory, CategoryAccent> = {
  movie: {
    dot: 'bg-red-500',
    chip: 'bg-red-500/15 text-red-200 border-red-500/30',
    ring: 'ring-red-500/40',
    cell: 'bg-red-500/15 text-red-100 border border-red-500/25',
  },
  tv: {
    dot: 'bg-sky-400',
    chip: 'bg-sky-500/15 text-sky-200 border-sky-500/30',
    ring: 'ring-sky-500/40',
    cell: 'bg-sky-500/15 text-sky-100 border border-sky-500/25',
  },
  anime: {
    dot: 'bg-violet-400',
    chip: 'bg-violet-500/15 text-violet-200 border-violet-500/30',
    ring: 'ring-violet-500/40',
    cell: 'bg-violet-500/15 text-violet-100 border border-violet-500/25',
  },
  documentary: {
    dot: 'bg-emerald-400',
    chip: 'bg-emerald-500/15 text-emerald-200 border-emerald-500/30',
    ring: 'ring-emerald-500/40',
    cell: 'bg-emerald-500/15 text-emerald-100 border border-emerald-500/25',
  },
  other: {
    dot: 'bg-amber-400',
    chip: 'bg-amber-500/15 text-amber-200 border-amber-500/30',
    ring: 'ring-amber-500/40',
    cell: 'bg-amber-500/15 text-amber-100 border border-amber-500/25',
  },
};
