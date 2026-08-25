/**
 * Entrées de calendrier saisies par l'utilisateur : lecture, écriture, et
 * développement des répétitions.
 *
 * Le stockage passe par `localStorage` sous une clé inscrite dans l'allowlist
 * de synchronisation (`utils/syncStorage.ts`) : les entrées suivent donc le
 * compte d'un appareil à l'autre, sans code serveur supplémentaire.
 *
 * Toute la manipulation de dates se fait sur des chaînes `YYYY-MM-DD` et des
 * `Date` construites champ par champ. `new Date('2026-03-15')` serait
 * interprété comme minuit UTC — à l'ouest de Greenwich, l'événement reculerait
 * d'un jour à l'affichage.
 */
import type {
  CalendarCategory,
  CalendarOccurrence,
  CalendarRecurrence,
  UserCalendarEntry,
} from '../types/calendar';

export const CALENDAR_ENTRIES_STORAGE_KEY = 'movixCalendarEntries';

/**
 * Garde-fou sur les répétitions sans fin : au-delà, on cesse de produire des
 * occurrences pour une même entrée sur une même fenêtre. Une fenêtre
 * d'affichage couvre au plus quelques mois, donc la borne n'est jamais
 * atteinte en usage normal — elle empêche seulement une entrée corrompue
 * (date invalide, `recurrenceUntil` absurde) de faire tourner la boucle
 * indéfiniment.
 */
const MAX_OCCURRENCES_PER_ENTRY = 500;

/** `YYYY-MM-DD` d'une date locale. `toISOString()` basculerait en UTC. */
export const toDateKey = (date: Date): string => {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
};

/** Inverse de `toDateKey`, en heure locale. `null` si la chaîne est invalide. */
export const parseDateKey = (key: string): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  // Rejette les dates qui « débordent » — le 31 février deviendrait le 3 mars.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
};

export const todayKey = (): string => toDateKey(new Date());

const isValidTime = (time: string): boolean => /^([01]\d|2[0-3]):[0-5]\d$/.test(time);

/**
 * Catégories acceptées à la relecture. `event` a existé dans une première
 * version du calendrier : les entrées déjà enregistrées sous ce nom deviennent
 * `other`, la catégorie fourre-tout, plutôt que d'être écartées.
 */
const KNOWN_CATEGORIES: CalendarCategory[] = ['movie', 'tv', 'anime', 'documentary', 'other'];

const readCategory = (value: unknown): CalendarCategory => (
  typeof value === 'string' && (KNOWN_CATEGORIES as string[]).includes(value)
    ? value as CalendarCategory
    : 'other'
);

/** Longueur du libellé libre, alignée sur ce que le formulaire laisse saisir. */
const CUSTOM_CATEGORY_MAX = 24;

const readRaw = (): unknown => {
  try {
    const raw = localStorage.getItem(CALENDAR_ENTRIES_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};

/** Ne garde que ce qui a la forme attendue : le stockage est réécrit par la synchro. */
const sanitize = (value: unknown): UserCalendarEntry[] => {
  if (!Array.isArray(value)) return [];
  const entries: UserCalendarEntry[] = [];

  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Partial<UserCalendarEntry>;
    if (typeof candidate.id !== 'string' || !candidate.id) continue;
    if (typeof candidate.title !== 'string' || !candidate.title.trim()) continue;
    if (typeof candidate.date !== 'string' || !parseDateKey(candidate.date)) continue;

    const category = readCategory(candidate.category);

    // Le libellé libre n'a de sens que pour `other` : le garder ailleurs
    // laisserait un « Concert » collé à une entrée redevenue « Film ».
    const customCategory =
      category === 'other' && typeof candidate.customCategory === 'string'
        && candidate.customCategory.trim()
        ? candidate.customCategory.trim().slice(0, CUSTOM_CATEGORY_MAX)
        : undefined;

    const recurrence: CalendarRecurrence =
      candidate.recurrence === 'weekly' || candidate.recurrence === 'monthly'
        || candidate.recurrence === 'yearly'
        ? candidate.recurrence
        : 'none';

    entries.push({
      id: candidate.id,
      title: candidate.title.trim(),
      date: candidate.date,
      time: typeof candidate.time === 'string' && isValidTime(candidate.time) ? candidate.time : undefined,
      category,
      customCategory,
      note: typeof candidate.note === 'string' && candidate.note.trim() ? candidate.note.trim() : undefined,
      recurrence,
      recurrenceUntil:
        typeof candidate.recurrenceUntil === 'string' && parseDateKey(candidate.recurrenceUntil)
          ? candidate.recurrenceUntil
          : undefined,
      link:
        candidate.link && typeof candidate.link === 'object'
          && (candidate.link.mediaType === 'movie' || candidate.link.mediaType === 'tv')
          && typeof candidate.link.tmdbId === 'number'
          ? {
            mediaType: candidate.link.mediaType,
            tmdbId: candidate.link.tmdbId,
            posterPath: typeof candidate.link.posterPath === 'string' ? candidate.link.posterPath : null,
          }
          : undefined,
      createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : new Date().toISOString(),
    });
  }

  return entries;
};

export const readCalendarEntries = (): UserCalendarEntry[] => sanitize(readRaw());

const writeCalendarEntries = (entries: UserCalendarEntry[]): void => {
  try {
    localStorage.setItem(CALENDAR_ENTRIES_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* stockage plein ou indisponible : l'entrée est perdue, on ne casse rien */
  }
};

const newId = (): string => {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* environnement sans crypto : repli ci-dessous */
  }
  return `cal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

export type CalendarEntryDraft = Omit<UserCalendarEntry, 'id' | 'createdAt'>;

export const addCalendarEntry = (draft: CalendarEntryDraft): UserCalendarEntry => {
  const entry: UserCalendarEntry = { ...draft, id: newId(), createdAt: new Date().toISOString() };
  const entries = readCalendarEntries();
  entries.push(entry);
  writeCalendarEntries(entries);
  return entry;
};

export const updateCalendarEntry = (id: string, draft: CalendarEntryDraft): void => {
  const entries = readCalendarEntries();
  const index = entries.findIndex((entry) => entry.id === id);
  if (index === -1) return;
  entries[index] = { ...entries[index], ...draft };
  writeCalendarEntries(entries);
};

export const removeCalendarEntry = (id: string): void => {
  writeCalendarEntries(readCalendarEntries().filter((entry) => entry.id !== id));
};

/** Avance d'un cran de répétition. `null` si le cran n'existe pas ce mois-là. */
const nextOccurrenceDate = (
  start: Date,
  recurrence: CalendarRecurrence,
  step: number,
): Date | null => {
  switch (recurrence) {
    case 'weekly':
      return new Date(start.getFullYear(), start.getMonth(), start.getDate() + step * 7);

    case 'monthly': {
      // Le quantième est conservé tel quel : une entrée au 31 ne produit rien
      // en février ou en avril, plutôt que de glisser au 1er du mois suivant.
      // C'est le comportement des agendas courants, et le moins surprenant.
      const target = new Date(start.getFullYear(), start.getMonth() + step, 1);
      const candidate = new Date(target.getFullYear(), target.getMonth(), start.getDate());
      return candidate.getMonth() === target.getMonth() ? candidate : null;
    }

    case 'yearly': {
      // Même règle pour le 29 février : l'entrée ne réapparaît que les années
      // bissextiles.
      const candidate = new Date(start.getFullYear() + step, start.getMonth(), start.getDate());
      return candidate.getMonth() === start.getMonth() ? candidate : null;
    }

    default:
      return step === 0 ? new Date(start.getFullYear(), start.getMonth(), start.getDate()) : null;
  }
};

/** Nombre de crans à sauter pour atteindre `from` sans boucler jour par jour. */
const stepsBefore = (start: Date, from: Date, recurrence: CalendarRecurrence): number => {
  if (from <= start) return 0;
  switch (recurrence) {
    case 'weekly': {
      const days = Math.floor((from.getTime() - start.getTime()) / 86_400_000);
      return Math.floor(days / 7);
    }
    case 'monthly':
      return (from.getFullYear() - start.getFullYear()) * 12 + (from.getMonth() - start.getMonth());
    case 'yearly':
      return from.getFullYear() - start.getFullYear();
    default:
      return 0;
  }
};

/**
 * Développe une entrée en occurrences datées sur la fenêtre `[fromKey, toKey]`,
 * bornes comprises.
 */
export const expandEntry = (
  entry: UserCalendarEntry,
  fromKey: string,
  toKey: string,
): CalendarOccurrence[] => {
  const start = parseDateKey(entry.date);
  const from = parseDateKey(fromKey);
  const to = parseDateKey(toKey);
  if (!start || !from || !to || to < from) return [];

  const until = entry.recurrenceUntil ? parseDateKey(entry.recurrenceUntil) : null;
  const hardEnd = until && until < to ? until : to;

  const occurrences: CalendarOccurrence[] = [];
  let step = stepsBefore(start, from, entry.recurrence);
  let produced = 0;

  while (produced < MAX_OCCURRENCES_PER_ENTRY) {
    const candidate = nextOccurrenceDate(start, entry.recurrence, step);
    step += 1;

    // Un cran inexistant (31 d'un mois court) ne termine pas la série : les
    // mois suivants peuvent de nouveau convenir.
    if (!candidate) {
      if (entry.recurrence === 'none') break;
      const probe = new Date(start.getFullYear(), start.getMonth(), 1);
      if (entry.recurrence === 'monthly') probe.setMonth(probe.getMonth() + step);
      else probe.setFullYear(probe.getFullYear() + step);
      if (probe > hardEnd) break;
      continue;
    }

    if (candidate > hardEnd) break;
    if (candidate >= from) {
      const dateKey = toDateKey(candidate);
      occurrences.push({
        key: `${entry.id}@${dateKey}`,
        source: 'custom',
        category: entry.category,
        customCategory: entry.customCategory,
        date: dateKey,
        time: entry.time,
        title: entry.title,
        note: entry.note,
        posterPath: entry.link?.posterPath ?? undefined,
        href: entry.link ? `/${entry.link.mediaType}/${entry.link.tmdbId}` : undefined,
        entryId: entry.id,
      });
      produced += 1;
    }

    if (entry.recurrence === 'none') break;
  }

  return occurrences;
};

/** Développe toutes les entrées personnelles sur une fenêtre. */
export const expandCalendarEntries = (
  entries: UserCalendarEntry[],
  fromKey: string,
  toKey: string,
): CalendarOccurrence[] =>
  entries.flatMap((entry) => expandEntry(entry, fromKey, toKey));
