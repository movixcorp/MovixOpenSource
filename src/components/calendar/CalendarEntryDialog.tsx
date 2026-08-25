import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarPlus, Trash2 } from 'lucide-react';
import ReusableModal from '../ui/reusable-modal';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { parseDateKey } from '../../utils/calendarEntries';
import { CALENDAR_CATEGORIES, CATEGORY_ACCENT } from './categoryAccent';
import { CalendarDateField, CalendarRecurrenceField, CalendarTimeField } from './CalendarFields';
import CalendarTitleField, { type TitleSelection } from './CalendarTitleField';
import type {
  CalendarCategory,
  CalendarMediaLink,
  CalendarRecurrence,
  UserCalendarEntry,
} from '../../types/calendar';
import type { CalendarEntryDraft } from '../../utils/calendarEntries';

interface CalendarEntryDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (draft: CalendarEntryDraft) => void;
  onDelete?: () => void;
  /** Entrée en cours de modification. Absent = création. */
  entry?: UserCalendarEntry | null;
  /** Date pré-remplie quand on ouvre depuis une case du calendrier. */
  defaultDate?: string;
}

/**
 * Longueur du libellé libre. Au-delà, il déborde de la pastille dans la grille
 * et dans la légende : mieux vaut le borner à la saisie que le tronquer partout.
 */
const CUSTOM_CATEGORY_MAX = 24;

const fieldLabel = 'block text-xs font-medium uppercase tracking-wider text-white/50 mb-2';

/**
 * Erreurs de saisie, par champ. Une seule fonction les calcule pour tout le
 * formulaire : le bouton d'envoi et les messages sous les champs lisent la même
 * source, il ne peut donc plus arriver qu'un champ soit signalé en rouge alors
 * que l'enregistrement passe (ou l'inverse).
 */
interface FieldErrors {
  title?: string;
  date?: string;
  until?: string;
}

const CalendarEntryDialog: React.FC<CalendarEntryDialogProps> = ({
  isOpen, onClose, onSave, onDelete, entry, defaultDate,
}) => {
  const { t } = useTranslation();

  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [category, setCategory] = useState<CalendarCategory>('other');
  const [customCategory, setCustomCategory] = useState('');
  const [note, setNote] = useState('');
  const [recurrence, setRecurrence] = useState<CalendarRecurrence>('none');
  const [recurrenceUntil, setRecurrenceUntil] = useState('');
  const [link, setLink] = useState<CalendarMediaLink | undefined>(undefined);
  const [submitted, setSubmitted] = useState(false);

  // Réinitialise à chaque ouverture : le composant reste monté entre deux
  // ouvertures, sans ça on rouvrirait sur la saisie précédente.
  useEffect(() => {
    if (!isOpen) return;
    setTitle(entry?.title ?? '');
    setDate(entry?.date ?? defaultDate ?? '');
    setTime(entry?.time ?? '');
    setCategory(entry?.category ?? 'other');
    setCustomCategory(entry?.customCategory ?? '');
    setNote(entry?.note ?? '');
    setRecurrence(entry?.recurrence ?? 'none');
    setRecurrenceUntil(entry?.recurrenceUntil ?? '');
    setLink(entry?.link);
    setSubmitted(false);
  }, [isOpen, entry, defaultDate]);

  const errors = useMemo<FieldErrors>(() => {
    const next: FieldErrors = {};
    if (!title.trim()) next.title = t('calendar.errorTitleRequired');
    if (!parseDateKey(date)) next.date = t('calendar.errorDateRequired');
    // La borne de fin ne concerne que les entrées qui se répètent : tant que la
    // répétition est « aucune », une valeur restée dans le champ n'est ni
    // enregistrée ni signalée.
    if (recurrence !== 'none' && recurrenceUntil) {
      if (!parseDateKey(recurrenceUntil)) next.until = t('calendar.errorDateRequired');
      else if (parseDateKey(date) && recurrenceUntil < date) next.until = t('calendar.errorUntilBeforeDate');
    }
    return next;
  }, [title, date, recurrence, recurrenceUntil, t]);

  // Les erreurs de champ obligatoire n'apparaissent qu'après une tentative
  // d'envoi — signaler « titre requis » sur un formulaire vierge est agressif.
  // La contradiction de dates, elle, résulte d'un choix explicite : on la
  // montre tout de suite.
  const showTitleError = submitted && Boolean(errors.title);
  const showDateError = submitted && Boolean(errors.date);

  const applySelection = useCallback((selection: TitleSelection) => {
    setTitle(selection.title);
    setLink(selection.link);
    setCategory(selection.category);
    // La date de sortie ne s'impose jamais à un choix déjà fait : elle ne
    // remplit que le champ resté vide.
    setDate((current) => (
      !current && selection.releaseDate && parseDateKey(selection.releaseDate)
        ? selection.releaseDate
        : current
    ));
  }, []);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (Object.keys(errors).length > 0) return;

    const label = customCategory.trim();
    onSave({
      title: title.trim(),
      date,
      time: time || undefined,
      category,
      customCategory: category === 'other' && label ? label : undefined,
      note: note.trim() || undefined,
      recurrence,
      recurrenceUntil: recurrence !== 'none' && recurrenceUntil ? recurrenceUntil : undefined,
      link,
    });
    onClose();
  };

  return (
    <ReusableModal
      isOpen={isOpen}
      onClose={onClose}
      title={entry ? t('calendar.editEntry') : t('calendar.newEntry')}
      className="max-w-lg"
    >
      <form onSubmit={submit} className="space-y-5">
        <div>
          <label className={fieldLabel} htmlFor="cal-title">{t('calendar.fieldTitle')}</label>
          <CalendarTitleField
            id="cal-title"
            value={title}
            onChange={setTitle}
            onSelect={applySelection}
            linked={link}
            onUnlink={() => setLink(undefined)}
            invalid={showTitleError}
          />
          {showTitleError && <p className="mt-1.5 text-xs text-red-400">{errors.title}</p>}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={fieldLabel} htmlFor="cal-date">{t('calendar.fieldDate')}</label>
            <CalendarDateField id="cal-date" value={date} onChange={setDate} invalid={showDateError} />
            {showDateError && <p className="mt-1.5 text-xs text-red-400">{errors.date}</p>}
          </div>
          <div>
            <label className={fieldLabel} htmlFor="cal-time">{t('calendar.fieldTime')}</label>
            <CalendarTimeField id="cal-time" value={time} onChange={setTime} />
          </div>
        </div>

        <div>
          <span className={fieldLabel}>{t('calendar.fieldCategory')}</span>
          {/* Des pastilles qui s'ajustent au texte plutôt qu'une grille de
              colonnes égales : « Documentaire » ne tient pas dans un cinquième
              de la modale, et un libellé tronqué ne se choisit pas. */}
          <div className="flex flex-wrap gap-2">
            {CALENDAR_CATEGORIES.map((value) => {
              const active = category === value;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setCategory(value)}
                  aria-pressed={active}
                  className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs transition-all duration-200 ${
                    active
                      ? `${CATEGORY_ACCENT[value].chip} ring-2 ${CATEGORY_ACCENT[value].ring}`
                      : 'border-white/10 bg-white/5 text-white/60 hover:bg-white/10'
                  }`}
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${CATEGORY_ACCENT[value].dot}`} />
                  {t(`calendar.category.${value}`)}
                </button>
              );
            })}
          </div>

          {category === 'other' && (
            <div className="mt-3">
              <label className={fieldLabel} htmlFor="cal-custom-category">
                {t('calendar.customCategoryLabel')}
              </label>
              <Input
                id="cal-custom-category"
                value={customCategory}
                maxLength={CUSTOM_CATEGORY_MAX}
                onChange={(e) => setCustomCategory(e.target.value)}
                placeholder={t('calendar.customCategoryPlaceholder')}
              />
            </div>
          )}
        </div>

        <div>
          <label className={fieldLabel} htmlFor="cal-recurrence">{t('calendar.fieldRecurrence')}</label>
          <CalendarRecurrenceField id="cal-recurrence" value={recurrence} onChange={setRecurrence} />
        </div>

        {recurrence !== 'none' && (
          <div>
            <label className={fieldLabel} htmlFor="cal-until">{t('calendar.fieldRecurrenceUntil')}</label>
            <CalendarDateField
              id="cal-until"
              value={recurrenceUntil}
              onChange={setRecurrenceUntil}
              min={date || undefined}
              invalid={Boolean(errors.until)}
            />
            <p className={`mt-1.5 text-xs ${errors.until ? 'text-red-400' : 'text-white/40'}`}>
              {errors.until ?? t('calendar.fieldRecurrenceUntilHint')}
            </p>
          </div>
        )}

        <div>
          <label className={fieldLabel} htmlFor="cal-note">{t('calendar.fieldNote')}</label>
          <textarea
            id="cal-note" value={note} rows={2}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('calendar.fieldNotePlaceholder')}
            className="w-full resize-none rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white transition-all duration-200 placeholder:text-white/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50"
          />
        </div>

        <div className="flex items-center gap-3 pt-1">
          {entry && onDelete && (
            <Button type="button" variant="destructive" className="gap-2" onClick={() => { onDelete(); onClose(); }}>
              <Trash2 className="h-4 w-4" />
              {t('common.delete')}
            </Button>
          )}
          <div className="ml-auto flex items-center gap-3">
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" className="gap-2">
              <CalendarPlus className="h-4 w-4" />
              {entry ? t('common.save') : t('calendar.addToCalendar')}
            </Button>
          </div>
        </div>
      </form>
    </ReusableModal>
  );
};

export default CalendarEntryDialog;
