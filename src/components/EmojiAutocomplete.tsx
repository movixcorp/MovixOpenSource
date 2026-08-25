import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { getOverlayPortalRoot } from '../utils/overlayPortal';

interface EmojiAutocompleteProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
}

interface EmojiMatch {
  id: string;
  native: string;
  name: string;
}

// Lazy-loaded module-level emoji index. Built once on first lookup that has 2+
// chars after a `:`. The dataset is ~150 KB minified so we don't want it in the
// initial bundle for routes that mount the textarea but never type a colon.
let emojiIndexPromise: Promise<{
  all: EmojiMatch[];
  aliases: Record<string, string>;
  byId: Record<string, any>;
}> | null = null;

const getEmojiIndex = () => {
  if (emojiIndexPromise) return emojiIndexPromise;
  emojiIndexPromise = (async () => {
    const dataMod = await import('@emoji-mart/data/sets/14/apple.json');
    const data: any = (dataMod as any).default ?? dataMod;
    const all: EmojiMatch[] = Object.values(data.emojis).map((e: any) => ({
      id: e.id,
      native: e.skins?.[0]?.native || '',
      name: e.name,
    }));
    return {
      all,
      aliases: data.aliases || {},
      byId: data.emojis,
    };
  })();
  return emojiIndexPromise;
};

const searchEmojisAsync = async (query: string): Promise<EmojiMatch[]> => {
  const q = query.toLowerCase();
  if (q.length < 2) return [];

  const { all, aliases, byId } = await getEmojiIndex();

  const aliasMatches: EmojiMatch[] = [];
  for (const [alias, emojiId] of Object.entries(aliases)) {
    if (alias.startsWith(q)) {
      const emoji = byId[emojiId as string];
      if (emoji) {
        aliasMatches.push({
          id: alias,
          native: emoji.skins?.[0]?.native || '',
          name: emoji.name,
        });
      }
    }
  }

  const idMatches = all.filter(
    (e) => e.id.startsWith(q) || e.id.includes(q)
  );

  const seen = new Set<string>();
  const results: EmojiMatch[] = [];
  for (const match of [...aliasMatches, ...idMatches]) {
    if (!seen.has(match.native) && match.native) {
      seen.add(match.native);
      results.push(match);
    }
    if (results.length >= 8) break;
  }
  return results;
};

// Calcule la position du caret relative au textarea
const getCaretCoordinates = (textarea: HTMLTextAreaElement, position: number) => {
  const mirror = document.createElement('div');
  const computed = getComputedStyle(textarea);

  const props = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle',
    'letterSpacing', 'textTransform', 'wordSpacing',
    'textIndent', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'lineHeight', 'whiteSpace', 'wordWrap', 'overflowWrap',
  ] as const;

  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordWrap = 'break-word';
  mirror.style.width = `${textarea.offsetWidth}px`;

  for (const prop of props) {
    (mirror.style as any)[prop] = computed[prop];
  }

  const textBefore = textarea.value.substring(0, position);
  mirror.textContent = textBefore;

  const span = document.createElement('span');
  span.textContent = '|';
  mirror.appendChild(span);

  document.body.appendChild(mirror);
  const { offsetTop, offsetLeft } = span;
  document.body.removeChild(mirror);

  return {
    top: offsetTop - textarea.scrollTop,
    left: offsetLeft,
  };
};

const DROPDOWN_WIDTH = 260;

const EmojiAutocomplete: React.FC<EmojiAutocompleteProps> = ({ textareaRef, value, onChange, maxLength }) => {
  const [suggestions, setSuggestions] = useState<EmojiMatch[]>([]);
  const [colonIndex, setColonIndex] = useState(-1);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [show, setShow] = useState(false);
  const [fixedPos, setFixedPos] = useState({ top: 0, left: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  const getQuery = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return null;

    const cursor = textarea.selectionStart;
    const textBefore = value.substring(0, cursor);

    const lastColon = textBefore.lastIndexOf(':');
    if (lastColon === -1) return null;
    if (lastColon > 0 && textBefore[lastColon - 1] === ':') return null;

    const query = textBefore.substring(lastColon + 1);
    if (/[\s]/.test(query)) return null;

    return { query, colonIndex: lastColon };
  }, [value, textareaRef]);

  useEffect(() => {
    const result = getQuery();
    if (!result || result.query.length < 2) {
      setShow(false);
      setSuggestions([]);
      return;
    }

    let cancelled = false;
    (async () => {
      const matches = await searchEmojisAsync(result.query);
      if (cancelled) return;
      if (matches.length === 0) {
        setShow(false);
        setSuggestions([]);
        return;
      }

      setSuggestions(matches);
      setColonIndex(result.colonIndex);
      setSelectedIndex(0);
      setShow(true);

      // Position fixe dans le viewport (pour le portail)
      const textarea = textareaRef.current;
      if (textarea) {
        const caretPos = getCaretCoordinates(textarea, result.colonIndex);
        const textareaRect = textarea.getBoundingClientRect();
        const lineHeight = parseInt(getComputedStyle(textarea).lineHeight) || 20;

        // Position absolue du caret dans le viewport
        const caretViewportTop = textareaRect.top + caretPos.top;
        const caretViewportLeft = textareaRect.left + caretPos.left;

        // Déterminer si afficher au-dessus ou en-dessous
        const dropdownHeight = Math.min(matches.length * 40, 280);
        const spaceBelow = window.innerHeight - caretViewportTop - lineHeight;
        const showAbove = spaceBelow < dropdownHeight + 20;

        setFixedPos({
          top: showAbove
            ? caretViewportTop - dropdownHeight - 4
            : caretViewportTop + lineHeight + 4,
          left: Math.max(8, Math.min(caretViewportLeft, window.innerWidth - DROPDOWN_WIDTH - 8)),
        });
      }
    })();

    return () => { cancelled = true; };
  }, [value, getQuery, textareaRef]);

  const insertEmoji = useCallback((emoji: EmojiMatch) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const cursor = textarea.selectionStart;
    const newValue = value.substring(0, colonIndex) + emoji.native + value.substring(cursor);

    if (maxLength && newValue.length > maxLength) return;

    onChange(newValue);
    setShow(false);

    const newCursorPos = colonIndex + emoji.native.length;
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(newCursorPos, newCursorPos);
    });
  }, [value, colonIndex, onChange, textareaRef, maxLength]);

  useEffect(() => {
    if (!show) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!show || suggestions.length === 0) return;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex(prev => (prev + 1) % suggestions.length);
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex(prev => (prev - 1 + suggestions.length) % suggestions.length);
          break;
        case 'Enter':
        case 'Tab':
          e.preventDefault();
          insertEmoji(suggestions[selectedIndex]);
          break;
        case 'Escape':
          e.preventDefault();
          setShow(false);
          break;
      }
    };

    const textarea = textareaRef.current;
    textarea?.addEventListener('keydown', handleKeyDown);
    return () => textarea?.removeEventListener('keydown', handleKeyDown);
  }, [show, suggestions, selectedIndex, insertEmoji, textareaRef]);

  useEffect(() => {
    if (!show) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShow(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [show]);

  return createPortal(
    <AnimatePresence>
      {show && suggestions.length > 0 && (
        <motion.div
          ref={containerRef}
          initial={{ opacity: 0, y: 4, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 4, scale: 0.97 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
          className="fixed z-[100000] bg-gray-800/95 backdrop-blur-sm border border-gray-600/50 rounded-lg shadow-2xl overflow-hidden overflow-y-auto"
          style={{
            top: fixedPos.top,
            left: fixedPos.left,
            width: DROPDOWN_WIDTH,
            maxHeight: 280,
          }}
        >
          {suggestions.map((emoji, index) => (
            <button
              key={emoji.id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                insertEmoji(emoji);
              }}
              onMouseEnter={() => setSelectedIndex(index)}
              className={`w-full flex items-center gap-3 px-3 py-2 text-left text-sm transition-colors ${
                index === selectedIndex ? 'bg-blue-600/30 text-white' : 'text-gray-300 hover:bg-gray-700/50'
              }`}
            >
              <span className="text-lg flex-shrink-0">{emoji.native}</span>
              <span className="truncate text-gray-400">:{emoji.id}:</span>
            </button>
          ))}
        </motion.div>
      )}
    </AnimatePresence>,
    getOverlayPortalRoot()
  );
};

export default EmojiAutocomplete;
