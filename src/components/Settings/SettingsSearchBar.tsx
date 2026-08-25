import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { rankSettingsSearch, type SettingsSearchItem } from '@/utils/settingsSearch';

interface SettingsSearchBarProps {
  contentRootRef: RefObject<HTMLElement>;
  onNavigate: (sectionId: string, target: HTMLElement) => void;
}

const slugify = (value: string) => value
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '');

export const SettingsSearchBar = ({ contentRootRef, onNavigate }: SettingsSearchBarProps) => {
  const { t, i18n } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const targetMapRef = useRef(new Map<string, HTMLElement>());
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<SettingsSearchItem[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const collectItems = useCallback(() => {
    const root = contentRootRef.current;
    if (!root) {
      targetMapRef.current = new Map();
      setItems([]);
      return;
    }

    const candidates = Array.from(root.querySelectorAll<HTMLElement>(
      '[data-settings-search-title], section[id] h2, section[id] h3, section[id] h4',
    ));
    const duplicateCounts = new Map<string, number>();
    const seenTargets = new Set<HTMLElement>();
    const targets = new Map<string, HTMLElement>();
    const next = candidates.flatMap((candidate) => {
      const titleElement = candidate.matches('h2,h3,h4')
        ? candidate
        : candidate.querySelector<HTMLElement>('h2,h3,h4') ?? candidate;
      if (seenTargets.has(titleElement)) return [];
      seenTargets.add(titleElement);

      const section = candidate.closest<HTMLElement>('section[id]');
      const title = titleElement.innerText.trim();
      if (!section || section.id === 'sessions' || !title) return [];

      const baseId = `${section.id}-${slugify(title) || 'setting'}`;
      const duplicate = duplicateCounts.get(baseId) ?? 0;
      duplicateCounts.set(baseId, duplicate + 1);
      const id = `${baseId}-${duplicate}`;
      titleElement.dataset.settingsSearchId = id;
      const card = candidate.closest<HTMLElement>('[data-settings-search-title]')
        ?? candidate.parentElement
        ?? candidate;
      const siblingDescription = candidate.nextElementSibling?.matches('p')
        ? candidate.nextElementSibling as HTMLElement
        : null;
      const description = card.querySelector<HTMLElement>('p')?.innerText.trim()
        ?? siblingDescription?.innerText.trim()
        ?? '';
      const keywords = (card.dataset.settingsSearchKeywords ?? candidate.dataset.settingsSearchKeywords ?? '')
        .split(',')
        .map((keyword) => keyword.trim())
        .filter(Boolean);

      targets.set(id, titleElement);
      const sectionTitle = section.querySelector<HTMLElement>('h2')?.innerText.trim() ?? section.id;
      return [{ id, sectionId: section.id, sectionTitle, title, description, keywords }];
    });

    targetMapRef.current = targets;
    setItems(next);
  }, [contentRootRef]);

  useEffect(() => {
    collectItems();
  }, [collectItems, i18n.language, query]);

  const results = useMemo(
    () => rankSettingsSearch(query, items),
    [items, query],
  );
  const isExpanded = open && Boolean(query.trim());
  const activeResultIndex = results.length ? Math.min(activeIndex, results.length - 1) : 0;

  useEffect(() => {
    setActiveIndex((index) => results.length ? Math.min(index, results.length - 1) : 0);
  }, [results.length]);

  const activate = (item: SettingsSearchItem) => {
    const target = targetMapRef.current.get(item.id);
    const root = contentRootRef.current;
    if (!target || !root || !target.isConnected || !root.contains(target)) {
      collectItems();
      return;
    }
    onNavigate(item.sectionId, target);
    setOpen(false);
    setQuery('');
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (!results.length) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((index) => (index + delta + results.length) % results.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      activate(results[activeResultIndex] ?? results[0]);
    }
  };

  return (
    <div className="sticky top-16 z-40 mx-auto w-full max-w-2xl md:top-20">
      <div className="relative">
        <span data-settings-search-icon className="pointer-events-none absolute left-2 top-1/2 z-10 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg bg-white/[0.06] text-white" aria-hidden="true">
          <Search className="h-4 w-4" />
        </span>
        <input
          ref={inputRef}
          type="text"
          inputMode="search"
          role="combobox"
          value={query}
          onFocus={() => {
            collectItems();
            setOpen(true);
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setActiveIndex(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder={t('settings.search.placeholder')}
          aria-label={t('settings.search.placeholder')}
          aria-controls="settings-search-results"
          aria-expanded={isExpanded}
          aria-autocomplete="list"
          aria-activedescendant={isExpanded && results.length ? `settings-search-option-${activeResultIndex}` : undefined}
          className="h-12 w-full rounded-2xl border border-white/10 bg-[#0d0d13]/95 pl-14 pr-12 text-sm text-white shadow-xl backdrop-blur-xl outline-none focus:border-red-500/50"
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setOpen(false);
              inputRef.current?.focus();
            }}
            aria-label={t('settings.search.clear')}
            className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-2 text-gray-400 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        )}
        {isExpanded && (
          <div
            id="settings-search-results"
            role="listbox"
            className="absolute left-1/2 top-full mt-2 max-h-[min(70vh,42rem)] w-[min(1120px,calc(100vw-2rem))] -translate-x-1/2 overflow-y-auto rounded-2xl border border-white/10 bg-[#0d0d13]/98 p-4 shadow-2xl backdrop-blur-xl"
          >
            {results.length ? (
              <>
                <p className="mb-2 text-xs text-gray-500">
                  {t('settings.searchResults', { count: results.length })}
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {results.map((item, index) => (
                    <button
                      id={`settings-search-option-${index}`}
                      key={item.id}
                      type="button"
                      role="option"
                      aria-selected={index === activeResultIndex}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => activate(item)}
                      className={`min-w-0 rounded-xl border px-3 py-2.5 text-left transition-colors ${index === activeResultIndex
                        ? 'border-red-500/50 bg-red-500/10 text-white'
                        : 'border-gray-800/80 bg-black/20 text-gray-300 hover:border-red-500/50 hover:bg-red-500/5'
                      }`}
                    >
                      <span className="block truncate text-sm font-medium">{item.title}</span>
                      {item.description && (
                        <span className="mt-1 block truncate text-xs text-gray-500">{item.description}</span>
                      )}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <p className="rounded-xl border border-dashed border-gray-800 px-3 py-3 text-sm text-gray-500">
                {t('settings.searchNoResults')}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
