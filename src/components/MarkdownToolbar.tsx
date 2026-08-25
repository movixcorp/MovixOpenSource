import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Bold, Italic, Code, Link, List, ListOrdered, Quote, Strikethrough, Eye, EyeOff, Info, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { useSafeRemarkGfm } from '../utils/markdownPlugins';
import remarkEmoji from 'remark-emoji';
import { useTranslation } from 'react-i18next';
import EmojiAutocomplete from './EmojiAutocomplete';
import { getOverlayPortalRoot } from '../utils/overlayPortal';

interface MarkdownToolbarProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
}

const previewComponents = {
  p: ({ children }: any) => <p className="mb-1 last:mb-0">{children}</p>,
  strong: ({ children }: any) => <strong className="font-bold text-white">{children}</strong>,
  em: ({ children }: any) => <em className="italic">{children}</em>,
  code: ({ children, className }: any) => {
    const isBlock = className?.includes('language-');
    return isBlock ? (
      <pre className="bg-gray-900/50 rounded p-2 my-1 overflow-x-auto text-xs">
        <code className={className}>{children}</code>
      </pre>
    ) : (
      <code className="bg-gray-900/50 text-blue-300 px-1 py-0.5 rounded text-[0.85em]">{children}</code>
    );
  },
  pre: ({ children }: any) => <>{children}</>,
  a: ({ href, children }: any) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline break-all">
      {children}
    </a>
  ),
  ul: ({ children }: any) => <ul className="list-disc list-inside ml-2 my-1">{children}</ul>,
  ol: ({ children }: any) => <ol className="list-decimal list-inside ml-2 my-1">{children}</ol>,
  blockquote: ({ children }: any) => (
    <blockquote className="border-l-2 border-gray-500 pl-2 my-1 text-gray-400 italic">{children}</blockquote>
  ),
  del: ({ children }: any) => <del className="line-through text-gray-500">{children}</del>,
  img: () => null,
  h1: ({ children }: any) => <p className="font-bold text-white mb-1">{children}</p>,
  h2: ({ children }: any) => <p className="font-bold text-white mb-1">{children}</p>,
  h3: ({ children }: any) => <p className="font-bold text-white mb-1">{children}</p>,
  h4: ({ children }: any) => <p className="font-bold text-white mb-1">{children}</p>,
  h5: ({ children }: any) => <p className="font-bold text-white mb-1">{children}</p>,
  h6: ({ children }: any) => <p className="font-bold text-white mb-1">{children}</p>,
};

type FormatAction = {
  icon: React.ReactNode;
  label: string;
  wrap?: [string, string];
  prefix?: string;
};

const buildActions = (t: (key: string) => string): FormatAction[] => [
  { icon: <Bold className="w-3.5 h-3.5" />, label: t('markdownToolbar.bold'), wrap: ['**', '**'] },
  { icon: <Italic className="w-3.5 h-3.5" />, label: t('markdownToolbar.italic'), wrap: ['*', '*'] },
  { icon: <Strikethrough className="w-3.5 h-3.5" />, label: t('markdownToolbar.strikethrough'), wrap: ['~~', '~~'] },
  { icon: <Code className="w-3.5 h-3.5" />, label: t('markdownToolbar.code'), wrap: ['`', '`'] },
  { icon: <Link className="w-3.5 h-3.5" />, label: t('markdownToolbar.link'), wrap: ['[', '](url)'] },
  { icon: <Quote className="w-3.5 h-3.5" />, label: t('markdownToolbar.quote'), prefix: '> ' },
  { icon: <List className="w-3.5 h-3.5" />, label: t('markdownToolbar.list'), prefix: '- ' },
  { icon: <ListOrdered className="w-3.5 h-3.5" />, label: t('markdownToolbar.orderedList'), prefix: '1. ' },
];

const buildHelpItems = (t: (key: string) => string) => {
  const sampleText = t('markdownToolbar.sampleText');
  const sampleItem = t('markdownToolbar.sampleItem');

  return [
    { syntax: `**${sampleText}**`, result: t('markdownToolbar.bold'), preview: <strong className="text-white">{sampleText}</strong> },
    { syntax: `*${sampleText}*`, result: t('markdownToolbar.italic'), preview: <em>{sampleText}</em> },
    { syntax: `~~${sampleText}~~`, result: t('markdownToolbar.strikethrough'), preview: <del className="text-gray-500">{sampleText}</del> },
    { syntax: '`code`', result: t('markdownToolbar.inlineCode'), preview: <code className="bg-gray-900/50 text-blue-300 px-1 py-0.5 rounded text-xs">code</code> },
    { syntax: `[${sampleText}](url)`, result: t('markdownToolbar.link'), preview: <span className="text-blue-400 underline">{sampleText}</span> },
    { syntax: `> ${sampleText}`, result: t('markdownToolbar.quote'), preview: <span className="border-l-2 border-gray-500 pl-2 text-gray-400 italic">{sampleText}</span> },
    { syntax: `- ${sampleItem}`, result: t('markdownToolbar.list'), preview: <span>• {sampleItem}</span> },
    { syntax: `1. ${sampleItem}`, result: t('markdownToolbar.orderedList'), preview: <span>1. {sampleItem}</span> },
    { syntax: ':smile:', result: t('markdownToolbar.emoji'), preview: <span>😄</span> },
  ];
};

// Modal d'aide formatage (portail comme AvatarSelector)
const MarkdownHelpModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  const { t } = useTranslation();
  const [isClosing, setIsClosing] = useState(false);
  const helpItems = buildHelpItems(t);

  useEffect(() => {
    if (!isOpen) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const lenis = (window as any).lenis;
    if (lenis) lenis.stop();
    return () => {
      document.body.style.overflow = originalOverflow;
      if (lenis) lenis.start();
    };
  }, [isOpen]);

  const handleClose = () => {
    setIsClosing(true);
    setTimeout(() => {
      onClose();
      setIsClosing(false);
    }, 250);
  };

  if (!isOpen) return null;

  return createPortal(
    <AnimatePresence mode="wait">
      {isOpen && !isClosing && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-[100000]"
          onClick={(e) => {
            if (e.target === e.currentTarget) handleClose();
          }}
        >
          <motion.div
            initial={{ scale: 0.9, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0, y: 10 }}
            transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
            className="bg-gray-900 rounded-2xl p-6 max-w-md w-full border border-gray-700/50 shadow-2xl"
          >
            {/* Header */}
            <div className="flex justify-between items-center mb-5">
              <h3 className="text-lg font-bold text-white">{t('markdownToolbar.guideTitle')}</h3>
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleClose}
                className="text-gray-400 hover:text-white p-2 rounded-lg hover:bg-gray-800 transition-colors"
              >
                <X className="w-5 h-5" />
              </motion.button>
            </div>

            {/* Liste des syntaxes */}
            <div className="space-y-3">
              {helpItems.map((item) => (
                <div key={item.syntax} className="flex items-center gap-3">
                  <code className="bg-gray-800 text-gray-300 px-2.5 py-1.5 rounded-lg font-mono min-w-[130px] text-xs border border-gray-700/50">
                    {item.syntax}
                  </code>
                  <span className="text-gray-500">→</span>
                  <span className="text-gray-300 text-sm">{item.preview}</span>
                </div>
              ))}
            </div>

            {/* Footer */}
            <div className="mt-5 pt-4 border-t border-gray-700/50">
              <p className="text-xs text-gray-500">{t('markdownToolbar.emojiHelp')}</p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    getOverlayPortalRoot()
  );
};

const MarkdownToolbar: React.FC<MarkdownToolbarProps> = ({ textareaRef, value, onChange, maxLength }) => {
  const { t } = useTranslation();
  const [showPreview, setShowPreview] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const actions = buildActions(t);
  const safeRemarkGfm = useSafeRemarkGfm();
  const previewPlugins = useMemo(
    () => (safeRemarkGfm ? [safeRemarkGfm, remarkEmoji] : [remarkEmoji]),
    [safeRemarkGfm],
  );

  const applyFormat = (action: FormatAction) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = value.substring(start, end);

    let newValue: string;
    let cursorPos: number;

    if (action.wrap) {
      const [before, after] = action.wrap;
      const insertion = `${before}${selected || action.label}${after}`;
      newValue = value.substring(0, start) + insertion + value.substring(end);
      if (selected) {
        cursorPos = start + insertion.length;
      } else {
        cursorPos = start + before.length + action.label.length;
      }
    } else if (action.prefix) {
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const insertion = action.prefix;
      newValue = value.substring(0, lineStart) + insertion + value.substring(lineStart);
      cursorPos = start + insertion.length;
    } else {
      return;
    }

    if (maxLength && newValue.length > maxLength) return;

    onChange(newValue);

    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(cursorPos, cursorPos);
    });
  };

  return (
    <div className="flex flex-col gap-1 relative">
      <div className="flex items-center gap-0.5 flex-wrap">
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            onClick={() => applyFormat(action)}
            title={action.label}
            className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-600/50 rounded transition-colors duration-150"
          >
            {action.icon}
          </button>
        ))}
        <div className="w-px h-5 bg-gray-600/50 mx-1" />
        <button
          type="button"
          onClick={() => setShowPreview(!showPreview)}
            title={showPreview ? t('markdownToolbar.hidePreview') : t('markdownToolbar.preview')}
          className={`p-1.5 rounded transition-colors duration-150 flex items-center gap-1 text-xs ${
            showPreview ? 'text-blue-400 bg-blue-500/10' : 'text-gray-400 hover:text-white hover:bg-gray-600/50'
          }`}
        >
          {showPreview ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          <span className="hidden sm:inline">{showPreview ? t('common.hide') : t('markdownToolbar.preview')}</span>
        </button>
        <button
          type="button"
          onClick={() => setShowHelp(true)}
          title={t('markdownToolbar.guideTitle')}
          className="p-1.5 rounded transition-colors duration-150 flex items-center gap-1 text-xs text-gray-400 hover:text-white hover:bg-gray-600/50"
        >
          <Info className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Aperçu markdown */}
      {showPreview && value.trim() && (
        <div className="bg-gray-900/50 rounded-lg p-3 border border-gray-700/50 text-gray-300 text-sm break-words overflow-hidden">
          <ReactMarkdown remarkPlugins={previewPlugins} components={previewComponents}>
            {value}
          </ReactMarkdown>
        </div>
      )}

      {/* Autocomplete emoji */}
      <EmojiAutocomplete
        textareaRef={textareaRef}
        value={value}
        onChange={onChange}
        maxLength={maxLength}
      />

      {/* Modal d'aide (portail) */}
      <MarkdownHelpModal isOpen={showHelp} onClose={() => setShowHelp(false)} />
    </div>
  );
};

export default MarkdownToolbar;
