/**
 * Champs de saisie du calendrier : date, heure, répétition.
 *
 * Aucun contrôle natif. `<input type="date">` et `<select>` affichent le
 * sélecteur du système d'exploitation, qui ignore le thème du site et n'a pas
 * la même tête sur deux machines. Ces champs sont donc dessinés, et partagent
 * un même popover.
 *
 * Ce popover est rendu **en portail, en position fixe**, et non en `absolute`
 * sous son champ : le formulaire vit dans une modale dont le corps défile
 * (`overflow-y-auto`), qui rognerait un menu débordant vers le bas. Même
 * approche que `CustomDropdown`, dont ces champs reprennent la mécanique sans
 * en reprendre l'habillage — celui-ci est gris et bleu, là où le calendrier
 * suit le rouge du site.
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Clock, Repeat, X } from 'lucide-react';
import { parseDateKey, toDateKey } from '../../utils/calendarEntries';
import type { CalendarRecurrence } from '../../types/calendar';
import { getOverlayPortalRoot } from '../../utils/overlayPortal';

const TRIGGER_CLASS =
  'flex h-10 w-full items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/5 '
  + 'px-3 text-sm text-white transition-all duration-200 hover:bg-white/[0.07] '
  + 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50';

const PANEL_CLASS =
  'rounded-xl border border-white/10 bg-gray-900 shadow-2xl shadow-black/60';

/** Le popover doit passer au-dessus de la modale, qui est déjà très haut. */
const POPOVER_Z_INDEX = 100010;

interface PopoverProps {
  open: boolean;
  onClose: () => void;
  anchor: HTMLElement | null;
  children: React.ReactNode;
  /** Largeur souhaitée ; par défaut, celle du champ. */
  width?: number;
}

const Popover: React.FC<PopoverProps> = ({ open, onClose, anchor, children, width }) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({});

  const place = useCallback(() => {
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const panelHeight = panelRef.current?.offsetHeight ?? 320;
    const panelWidth = width ?? Math.max(rect.width, 260);
    // Bascule au-dessus quand le bas manque de place, et recadre
    // horizontalement pour ne jamais sortir de l'écran.
    const openUpwards = rect.bottom + panelHeight + 8 > window.innerHeight && rect.top > panelHeight;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - panelWidth - 8));
    setStyle({
      position: 'fixed',
      left,
      width: panelWidth,
      zIndex: POPOVER_Z_INDEX,
      ...(openUpwards ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
    });
  }, [anchor, width]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // Échap ferme le popover sans remonter jusqu'à la modale, sinon un seul
      // appui refermerait les deux.
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };

    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, anchor, onClose, place]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          ref={panelRef}
          initial={{ opacity: 0, y: -4, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -4, scale: 0.98 }}
          transition={{ duration: 0.14, ease: 'easeOut' }}
          style={style}
          data-lenis-prevent
          className={PANEL_CLASS}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>,
    getOverlayPortalRoot(),
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Date
// ─────────────────────────────────────────────────────────────────────────────

interface DateFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** `YYYY-MM-DD` en deçà duquel les jours sont désactivés. */
  min?: string;
  invalid?: boolean;
  id?: string;
}

export const CalendarDateField: React.FC<DateFieldProps> = ({ value, onChange, min, invalid, id }) => {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const selected = parseDateKey(value);
  const [cursor, setCursor] = useState(() => selected ?? new Date());

  // Rouvrir le champ doit montrer le mois de la date choisie, pas celui qu'on
  // regardait la fois précédente.
  useEffect(() => {
    if (open) setCursor(parseDateKey(value) ?? new Date());
  }, [open, value]);

  const locale = i18n.language || 'fr';
  const monthLabel = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' })
    .format(new Date(cursor.getFullYear(), cursor.getMonth(), 1));
  const weekdays = Array.from({ length: 7 }, (_, index) =>
    new Intl.DateTimeFormat(locale, { weekday: 'narrow' }).format(new Date(2024, 0, 1 + index)));

  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7; // semaine commençant lundi
  const days = Array.from({ length: 42 }, (_, index) =>
    new Date(cursor.getFullYear(), cursor.getMonth(), 1 - offset + index));

  const todayKeyValue = toDateKey(new Date());

  return (
    <>
      <button
        id={id}
        type="button"
        ref={setAnchor}
        onClick={() => setOpen((current) => !current)}
        className={`${TRIGGER_CLASS} ${invalid ? 'border-red-500/60' : ''}`}
      >
        <span className="flex items-center gap-2 truncate">
          <CalendarDays className="h-4 w-4 shrink-0 text-white/40" />
          <span className={selected ? '' : 'text-white/40'}>
            {selected
              ? new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(selected)
              : t('calendar.pickDate')}
          </span>
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-white/40 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} width={288}>
        <div className="p-3">
          <div className="mb-2 flex items-center justify-between">
            <button type="button" aria-label={t('calendar.previousMonth')}
              onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() - 1, 1))}
              className="rounded-lg p-1.5 text-white/60 transition-colors hover:bg-white/10 hover:text-white">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm font-semibold capitalize text-white">{monthLabel}</span>
            <button type="button" aria-label={t('calendar.nextMonth')}
              onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + 1, 1))}
              className="rounded-lg p-1.5 text-white/60 transition-colors hover:bg-white/10 hover:text-white">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          <div className="mb-1 grid grid-cols-7">
            {weekdays.map((label, index) => (
              <span key={index} className="py-1 text-center text-[10px] font-semibold uppercase text-white/35">
                {label}
              </span>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-0.5">
            {days.map((day) => {
              const key = toDateKey(day);
              const outside = day.getMonth() !== cursor.getMonth();
              const disabled = Boolean(min && key < min);
              const isSelected = key === value;
              return (
                <button
                  key={key}
                  type="button"
                  disabled={disabled}
                  onClick={() => { onChange(key); setOpen(false); }}
                  className={`h-8 rounded-md text-xs transition-colors ${
                    isSelected ? 'bg-red-600 font-semibold text-white'
                      : disabled ? 'cursor-not-allowed text-white/15'
                        : outside ? 'text-white/25 hover:bg-white/5'
                          : 'text-white/75 hover:bg-white/10'
                  } ${!isSelected && key === todayKeyValue ? 'ring-1 ring-inset ring-red-500/50' : ''}`}
                >
                  {day.getDate()}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => { onChange(todayKeyValue); setOpen(false); }}
            className="mt-2 w-full rounded-lg border border-white/10 bg-white/5 py-1.5 text-xs text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          >
            {t('calendar.today')}
          </button>
        </div>
      </Popover>
    </>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Heure
// ─────────────────────────────────────────────────────────────────────────────

const HOURS = Array.from({ length: 24 }, (_, index) => String(index).padStart(2, '0'));
const MINUTES = ['00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55'];

interface TimeFieldProps {
  /** `HH:MM`, ou chaîne vide pour « journée entière ». */
  value: string;
  onChange: (value: string) => void;
  id?: string;
}

export const CalendarTimeField: React.FC<TimeFieldProps> = ({ value, onChange, id }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [hour, minute] = value ? value.split(':') : ['', ''];

  const pick = (nextHour: string, nextMinute: string) => onChange(`${nextHour}:${nextMinute}`);

  return (
    <>
      <button
        id={id}
        type="button"
        ref={setAnchor}
        onClick={() => setOpen((current) => !current)}
        className={TRIGGER_CLASS}
      >
        <span className="flex items-center gap-2 truncate">
          <Clock className="h-4 w-4 shrink-0 text-white/40" />
          <span className={value ? '' : 'text-white/40'}>{value || t('calendar.allDay')}</span>
        </span>
        {value ? (
          <span
            role="button"
            tabIndex={-1}
            aria-label={t('calendar.clearTime')}
            onClick={(event) => { event.stopPropagation(); onChange(''); }}
            className="rounded p-0.5 text-white/40 transition-colors hover:text-white"
          >
            <X className="h-3.5 w-3.5" />
          </span>
        ) : (
          <ChevronDown className={`h-4 w-4 shrink-0 text-white/40 transition-transform ${open ? 'rotate-180' : ''}`} />
        )}
      </button>

      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} width={200}>
        <div className="flex h-56">
          {([['h', HOURS, hour], ['m', MINUTES, minute]] as const).map(([kind, options, current]) => (
            <div key={kind} className="flex-1 overflow-y-auto overscroll-contain border-r border-white/10 p-1 last:border-r-0">
              {options.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => pick(
                    kind === 'h' ? option : (hour || '20'),
                    kind === 'm' ? option : (minute || '00'),
                  )}
                  className={`w-full rounded-md py-1.5 text-center text-sm transition-colors ${
                    current === option ? 'bg-red-600 font-semibold text-white' : 'text-white/70 hover:bg-white/10'
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>
          ))}
        </div>
      </Popover>
    </>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Répétition
// ─────────────────────────────────────────────────────────────────────────────

const RECURRENCES: CalendarRecurrence[] = ['none', 'weekly', 'monthly', 'yearly'];

interface RecurrenceFieldProps {
  value: CalendarRecurrence;
  onChange: (value: CalendarRecurrence) => void;
  id?: string;
}

export const CalendarRecurrenceField: React.FC<RecurrenceFieldProps> = ({ value, onChange, id }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  return (
    <>
      <button
        id={id}
        type="button"
        ref={setAnchor}
        onClick={() => setOpen((current) => !current)}
        className={TRIGGER_CLASS}
      >
        <span className="flex items-center gap-2 truncate">
          <Repeat className="h-4 w-4 shrink-0 text-white/40" />
          {t(`calendar.recurrence.${value}`)}
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-white/40 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor}>
        <div className="p-1">
          {RECURRENCES.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => { onChange(option); setOpen(false); }}
              className={`w-full rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                value === option ? 'bg-red-600/20 text-red-200' : 'text-white/75 hover:bg-white/10'
              }`}
            >
              {t(`calendar.recurrence.${option}`)}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
};
