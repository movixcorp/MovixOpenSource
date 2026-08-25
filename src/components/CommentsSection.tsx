import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { Heart, MessageCircle, Trash2, Send, X, AlertTriangle, Info, ExternalLink, Popcorn, Flag } from 'lucide-react';
import { PrefetchLink as Link } from '@/routing/PrefetchLink';
import axios from 'axios';
import { toast } from 'sonner';
import { getVipHeaders } from '../utils/vipUtils';
import ReactMarkdown from 'react-markdown';
import { useSafeRemarkGfm } from '../utils/markdownPlugins';
import remarkEmoji from 'remark-emoji';
import MarkdownToolbar from './MarkdownToolbar';
import { useTurnstileBypass } from '../hooks/useTurnstileBypass';
import { ADMIN_BYPASS_TOKEN } from '../utils/turnstileBypass';
import { getOverlayPortalRoot } from '@/utils/overlayPortal';

const MAIN_API = import.meta.env.VITE_MAIN_API;
const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY;

const mdComponents = {
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
  a: ({ href, children }: any) => {
    if (!href || !/^https?:\/\//i.test(href)) return <span className="text-blue-400 break-all">{children}</span>;
    return <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline break-all">{children}</a>;
  },
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

declare global {
  interface Window {
    turnstile?: {
      render: (container: string | HTMLElement, options: Record<string, unknown>) => string;
      reset: (widgetId: string) => void;
      remove: (widgetId: string) => void;
    };
  }
}

// Composant de bouton personnalisé pour les spoilers
interface SpoilerToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  size?: 'sm' | 'md';
}

const SpoilerToggle: React.FC<SpoilerToggleProps> = ({ checked, onChange, size = 'md' }) => {
  const { t } = useTranslation();
  const sizeClasses = size === 'sm' ? 'text-xs px-3 py-1.5' : 'text-sm px-4 py-2';
  const iconSize = size === 'sm' ? 'w-3 h-3' : 'w-4 h-4';

  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`flex items-center gap-2 transition-all duration-200 rounded-lg font-medium ${checked
        ? 'bg-red-600/20 text-red-400 border-2 border-red-500/50 hover:bg-red-600/30 hover:border-red-500'
        : 'bg-gray-700/50 text-gray-300 border-2 border-gray-600/50 hover:bg-gray-700/70 hover:border-gray-500'
        } ${sizeClasses}`}
    >
      <AlertTriangle className={iconSize} />
        <span>{t('common.spoiler')}</span>
      {checked && (
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          className="w-2 h-2 bg-red-500 rounded-full"
        />
      )}
    </button>
  );
};

// Composant Skeleton pour les commentaires
const CommentSkeleton: React.FC = () => {
  return (
    <div className="bg-gray-800/70 rounded-xl p-3 sm:p-4 md:p-6 animate-pulse">
      <div className="flex items-start gap-2 sm:gap-3 md:gap-4">
        <div className="flex-shrink-0">
          <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-full bg-gray-700"></div>
        </div>
        <div className="flex-1 space-y-2 sm:space-y-3">
          {/* En-tête */}
          <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
            <div className="h-3 sm:h-4 w-20 sm:w-24 bg-gray-700 rounded"></div>
            <div className="h-3 sm:h-4 w-12 sm:w-16 bg-gray-700 rounded"></div>
            <div className="h-2.5 sm:h-3 w-16 sm:w-20 bg-gray-700 rounded"></div>
          </div>
          {/* Contenu */}
          <div className="space-y-2">
            <div className="h-3 sm:h-4 w-full bg-gray-700 rounded"></div>
            <div className="h-3 sm:h-4 w-5/6 bg-gray-700 rounded"></div>
            <div className="h-3 sm:h-4 w-4/6 bg-gray-700 rounded"></div>
          </div>
          {/* Actions */}
          <div className="flex items-center gap-2 sm:gap-4 mt-3 sm:mt-4">
            <div className="h-3 sm:h-4 w-10 sm:w-12 bg-gray-700 rounded"></div>
            <div className="h-3 sm:h-4 w-10 sm:w-12 bg-gray-700 rounded"></div>
            <div className="h-3 sm:h-4 w-12 sm:w-16 bg-gray-700 rounded"></div>
          </div>
        </div>
      </div>
    </div>
  );
};

interface Comment {
  id: number;
  content_type: string;
  content_id: string;
  user_id: string;
  user_type: string;
  profile_id: string | null;
  username: string;
  avatar: string | null;
  content: string;
  is_spoiler: number;
  is_vip: number;
  is_admin: number;
  is_edited: number;
  created_at: number;
  updated_at?: number;
  deleted: number;
  repliesCount: number;
  reactions: number;
  userReaction: boolean | null;
}

interface Reply {
  id: number;
  comment_id: number;
  parent_reply_id: number | null;
  user_id: string;
  user_type: string;
  profile_id: string | null;
  username: string;
  avatar: string | null;
  reply_to_username: string | null;
  content: string;
  is_spoiler: number;
  is_vip: number;
  is_admin: number;
  is_edited: number;
  created_at: number;
  updated_at?: number;
  deleted: number;
  reactions: number;
  userReaction: boolean | null;
}

interface CommentsSectionProps {
  contentType: 'movie' | 'tv';
  contentId: string;
}

interface CommentItemProps {
  comment: Comment;
  isLast: boolean;
  lastCommentRef: React.RefObject<HTMLDivElement>;
  // user identity
  isAuthenticated: boolean;
  isAdmin: boolean;
  profileId: string | null;
  // shared edit state
  editingComment: number | null;
  editContent: string;
  editIsSpoiler: boolean;
  editingReply: number | null;
  editTextareaRef: React.RefObject<HTMLTextAreaElement>;
  // shared reply state
  replyingTo: { commentId: number; replyId?: number; username: string } | null;
  replyContent: string;
  isReplySpoiler: boolean;
  replyTextareaRef: React.RefObject<HTMLTextAreaElement>;
  // replies data for this comment
  replies: Reply[] | undefined;
  expanded: boolean;
  repliesHasMore: boolean;
  repliesTotalCount: number;
  // delete/reveal/report sets
  deletingIds: Set<number>;
  deletedIds: Set<number>;
  revealedSpoilers: Set<string>;
  reportedIds: Set<string>;
  // turnstile
  turnstileToken: string;
  turnstileSiteKey: string | undefined;
  // i18n + helpers
  t: (key: string, opts?: unknown) => string;
  formatDate: (timestamp: number) => string;
  // callbacks
  onReaction: (targetType: 'comment' | 'reply', targetId: number) => void;
  onToggleReplies: (commentId: number) => void;
  onRevealSpoiler: (type: 'comment' | 'reply', id: number) => void;
  onRequestDeleteComment: (commentId: number) => void;
  onRequestDeleteReply: (replyId: number, commentId: number) => void;
  onPostReply: (commentId: number, parentReplyId?: number, replyToUsername?: string) => void;
  onEditComment: (commentId: number) => void;
  onEditReply: (replyId: number, commentId: number) => void;
  onLoadMoreReplies: (commentId: number) => void;
  setEditingComment: React.Dispatch<React.SetStateAction<number | null>>;
  setEditContent: React.Dispatch<React.SetStateAction<string>>;
  setEditIsSpoiler: React.Dispatch<React.SetStateAction<boolean>>;
  setEditingReply: React.Dispatch<React.SetStateAction<number | null>>;
  setReplyingTo: React.Dispatch<React.SetStateAction<{ commentId: number; replyId?: number; username: string } | null>>;
  setReplyContent: React.Dispatch<React.SetStateAction<string>>;
  setIsReplySpoiler: React.Dispatch<React.SetStateAction<boolean>>;
  setReportModal: React.Dispatch<React.SetStateAction<{ targetType: 'comment' | 'reply'; targetId: number } | null>>;
}

const CommentItem = React.memo<CommentItemProps>((props) => {
  const {
    comment,
    isLast,
    lastCommentRef,
    isAuthenticated,
    isAdmin,
    profileId,
    editingComment,
    editContent,
    editIsSpoiler,
    editingReply,
    editTextareaRef,
    replyingTo,
    replyContent,
    isReplySpoiler,
    replyTextareaRef,
    replies,
    expanded,
    repliesHasMore,
    repliesTotalCount,
    deletingIds,
    deletedIds,
    revealedSpoilers,
    reportedIds,
    turnstileToken,
    turnstileSiteKey,
    t,
    formatDate,
    onReaction,
    onToggleReplies,
    onRevealSpoiler,
    onRequestDeleteComment,
    onRequestDeleteReply,
    onPostReply,
    onEditComment,
    onEditReply,
    onLoadMoreReplies,
    setEditingComment,
    setEditContent,
    setEditIsSpoiler,
    setEditingReply,
    setReplyingTo,
    setReplyContent,
    setIsReplySpoiler,
    setReportModal,
  } = props;

  const safeRemarkGfm = useSafeRemarkGfm();
  const mdPlugins = useMemo(
    () => (safeRemarkGfm ? [safeRemarkGfm, remarkEmoji] : [remarkEmoji]),
    [safeRemarkGfm],
  );

  return (
    <motion.div
      key={comment.id}
      ref={isLast ? lastCommentRef : null}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      transition={{ duration: 0.3 }}
      className="bg-gray-800/70 rounded-xl p-3 sm:p-4 md:p-6 relative overflow-hidden"
    >
      {/* Overlay de suppression */}
      <AnimatePresence>
        {(deletingIds.has(comment.id) || deletedIds.has(comment.id)) && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-10 flex items-center justify-center bg-gray-900/80 backdrop-blur-sm rounded-xl"
          >
            <div className="text-center">
              {deletingIds.has(comment.id) ? (
                <div className="flex items-center gap-2 text-yellow-400">
                  <div className="w-4 h-4 border-2 border-yellow-400 border-t-transparent rounded-full animate-spin" />
                  <span className="text-sm font-medium">{t('comments.deleting')}</span>
                </div>
              ) : (
                <motion.div
                  initial={{ scale: 0.8 }}
                  animate={{ scale: 1 }}
                  className="flex items-center gap-2 text-red-400"
                >
                  <Trash2 className="w-4 h-4" />
                  <span className="text-sm font-medium">{t('comments.commentDeleted')}</span>
                </motion.div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* En-tête du commentaire */}
      <div className="flex items-start gap-2 sm:gap-3 md:gap-4">
        <div className="flex-shrink-0">
          {comment.avatar ? (
            <img
              src={comment.avatar}
              alt={comment.username}
              className="w-8 h-8 sm:w-10 sm:h-10 rounded-full"
            />
          ) : (
            <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-full bg-gradient-to-br from-gray-700 to-gray-900 flex items-center justify-center text-white font-bold text-sm sm:text-base">
              {comment.username.charAt(0).toUpperCase()}
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
            <span className="font-semibold text-white text-sm sm:text-base truncate">{comment.username}</span>
            {comment.is_admin === 1 && (
              <span className="px-1.5 sm:px-2 py-0.5 bg-red-600 text-white text-[10px] sm:text-xs rounded-full whitespace-nowrap">
                Admin
              </span>
            )}
            {comment.is_vip === 1 && (
              <span className="px-1.5 sm:px-2 py-0.5 bg-yellow-600 text-white text-[10px] sm:text-xs rounded-full whitespace-nowrap">
                VIP
              </span>
            )}
            <span className="text-[10px] sm:text-xs text-gray-400 whitespace-nowrap">{formatDate(comment.created_at)}</span>
            {comment.is_edited === 1 && (
              <span className="text-[10px] sm:text-xs text-gray-500 whitespace-nowrap">({t('comments.edited')})</span>
            )}
          </div>

          {/* Contenu du commentaire */}
          {editingComment === comment.id ? (
            <div className="mt-2 sm:mt-3">
              <textarea
                ref={editTextareaRef}
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                maxLength={500}
                className="w-full bg-gray-700/50 text-white rounded-lg p-2 sm:p-3 text-sm sm:text-base focus:outline-none focus:ring-2 focus:ring-red-600 resize-none"
                rows={3}
              />
              <MarkdownToolbar
                textareaRef={editTextareaRef}
                value={editContent}
                onChange={setEditContent}
                maxLength={500}
              />
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                <SpoilerToggle
                  checked={editIsSpoiler}
                  onChange={setEditIsSpoiler}
                  size="sm"
                />
                <button
                  onClick={() => onEditComment(comment.id)}
                  className="px-3 sm:px-4 py-1 bg-slate-800 hover:bg-slate-700 text-white rounded text-xs sm:text-sm"
                >
                  {t('common.save')}
                </button>
                <button
                  onClick={() => {
                    setEditingComment(null);
                    setEditContent('');
                  }}
                  className="px-3 sm:px-4 py-1 bg-gray-600 hover:bg-gray-700 text-white rounded text-xs sm:text-sm"
                >
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-2">
              <motion.div
                onClick={() => comment.is_spoiler === 1 && !revealedSpoilers.has(`comment-${comment.id}`) && onRevealSpoiler('comment', comment.id)}
                initial={{ filter: comment.is_spoiler === 1 ? 'blur(8px)' : 'blur(0px)' }}
                animate={{
                  filter: comment.is_spoiler === 1 && !revealedSpoilers.has(`comment-${comment.id}`) ? 'blur(8px)' : 'blur(0px)'
                }}
                transition={{
                  duration: 0.5,
                  ease: 'easeOut'
                }}
                className={`text-gray-200 text-sm sm:text-base break-words ${comment.is_spoiler === 1 && !revealedSpoilers.has(`comment-${comment.id}`) ? 'cursor-pointer' : ''
                  }`}
                title={comment.is_spoiler === 1 && !revealedSpoilers.has(`comment-${comment.id}`) ? t('comments.clickToReveal') : ''}
                whileHover={comment.is_spoiler === 1 && !revealedSpoilers.has(`comment-${comment.id}`) ? { filter: 'blur(4px)' } : {}}
              >
                <ReactMarkdown remarkPlugins={mdPlugins} components={mdComponents}>
                  {comment.content}
                </ReactMarkdown>
              </motion.div>
              {comment.is_spoiler === 1 && !revealedSpoilers.has(`comment-${comment.id}`) && (
                <motion.span
                  initial={{ opacity: 1 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="inline-flex items-center gap-1 mt-1 sm:mt-2 text-[10px] sm:text-xs text-red-400"
                >
                  <AlertTriangle className="w-3 h-3" />
                  <span className="hidden sm:inline">{t('comments.spoilerContent')}</span>
                                        <span className="sm:hidden">{t('common.spoiler')}</span>
                </motion.span>
              )}
            </div>
          )}

          {/* Actions du commentaire */}
          <div className="flex items-center gap-2 sm:gap-3 md:gap-4 mt-3 sm:mt-4 flex-wrap">
            <button
              onClick={() => onReaction('comment', comment.id)}
              className={`flex items-center gap-1 transition-colors ${comment.userReaction ? 'text-red-500' : 'text-gray-400 hover:text-red-500'
                }`}
              disabled={!isAuthenticated}
            >
              <Heart className={`w-3.5 h-3.5 sm:w-4 sm:h-4 ${comment.userReaction ? 'fill-current' : ''}`} />
              <span className="text-xs sm:text-sm">{comment.reactions}</span>
            </button>

            <button
              onClick={() => onToggleReplies(comment.id)}
              className="flex items-center gap-1 text-gray-400 hover:text-white transition-colors"
            >
              <MessageCircle className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              <span className="text-xs sm:text-sm">{comment.repliesCount}</span>
            </button>

            {isAuthenticated && (
              <button
                onClick={() => {
                  // Si on est déjà en train de répondre à ce commentaire, fermer le formulaire
                  if (replyingTo?.commentId === comment.id && !replyingTo?.replyId) {
                    setReplyingTo(null);
                  } else {
                    // Sinon, ouvrir/réafficher le formulaire de réponse
                    setReplyingTo({ commentId: comment.id, username: comment.username });
                    // S'assurer que les réponses sont ouvertes
                    if (!expanded) {
                      onToggleReplies(comment.id);
                    }
                  }
                }}
                className="text-xs sm:text-sm text-gray-400 hover:text-white transition-colors"
              >
                {t('comments.reply')}
              </button>
            )}

            {(isAdmin || (profileId && profileId === comment.profile_id)) && (
              <button
                onClick={() => onRequestDeleteComment(comment.id)}
                className="text-xs sm:text-sm text-red-500 hover:text-red-400 transition-colors flex items-center gap-1"
              >
                <Trash2 className="w-3 h-3" />
                <span className="hidden sm:inline">{t('common.delete')}</span>
              </button>
            )}

            {isAuthenticated && profileId !== comment.profile_id && !reportedIds.has(`comment-${comment.id}`) && (
              <button
                onClick={() => setReportModal({ targetType: 'comment', targetId: comment.id })}
                className="text-xs sm:text-sm text-gray-500 hover:text-orange-400 transition-colors flex items-center gap-1"
              >
                <Flag className="w-3 h-3" />
                <span className="hidden sm:inline">{t('comments.report', 'Signaler')}</span>
              </button>
            )}
            {reportedIds.has(`comment-${comment.id}`) && (
              <span className="text-xs sm:text-sm text-orange-400/60 flex items-center gap-1">
                <Flag className="w-3 h-3" />
                <span className="hidden sm:inline">{t('comments.reported', 'Signalé')}</span>
              </span>
            )}
          </div>

          {/* Réponses */}
          <AnimatePresence initial={false}>
            {expanded && (replyingTo?.commentId === comment.id || (replies && replies.length > 0)) && (
              <motion.div
                initial={{ opacity: 0, maxHeight: 0 }}
                animate={{
                  opacity: 1,
                  maxHeight: 2000,
                  transition: {
                    duration: 0.2,
                    ease: [0.4, 0, 0.2, 1],
                    opacity: { duration: 0.15 }
                  }
                }}
                exit={{
                  opacity: 0,
                  maxHeight: 0,
                  transition: {
                    duration: 0.15,
                    ease: [0.4, 0, 1, 1],
                    opacity: { duration: 0.1 },
                    maxHeight: { duration: 0.15 }
                  }
                }}
                style={{
                  overflow: 'hidden'
                }}
                className="mt-4 sm:mt-6 pl-3 sm:pl-4 md:pl-6 border-l-2 border-gray-700 space-y-3 sm:space-y-4"
              >
                {/* Formulaire de réponse pour le commentaire principal */}
                <AnimatePresence initial={false}>
                  {replyingTo?.commentId === comment.id && !replyingTo?.replyId && (
                    <motion.div
                      initial={{ opacity: 0, y: -10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{
                        opacity: 0,
                        y: -10,
                        transition: { duration: 0.15, ease: [0.4, 0, 1, 1] }
                      }}
                      transition={{
                        duration: 0.2,
                        ease: [0.4, 0, 0.2, 1]
                      }}
                      className="bg-gray-700/30 rounded-lg p-3 sm:p-4"
                    >
                      {replyingTo.username && (
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs sm:text-sm text-gray-400">
                            {t('comments.replyTo')} <span className="text-red-500">@{replyingTo.username}</span>
                          </span>
                          <button
                            onClick={() => setReplyingTo(null)}
                            className="text-gray-400 hover:text-white"
                          >
                            <X className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                          </button>
                        </div>
                      )}
                      <textarea
                        ref={replyTextareaRef}
                        value={replyContent}
                        onChange={(e) => setReplyContent(e.target.value)}
                        placeholder={t('comments.writeReply')}
                        maxLength={500}
                        className="w-full bg-gray-700/50 text-white rounded-lg p-2 sm:p-3 text-sm sm:text-base focus:outline-none focus:ring-2 focus:ring-red-600 resize-none"
                        rows={2}
                      />
                      <MarkdownToolbar
                        textareaRef={replyTextareaRef}
                        value={replyContent}
                        onChange={setReplyContent}
                        maxLength={500}
                      />
                      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 sm:gap-0 mt-2">
                        <SpoilerToggle
                          checked={isReplySpoiler}
                          onChange={setIsReplySpoiler}
                          size="sm"
                        />
                        <div className="flex items-center gap-2 w-full sm:w-auto justify-between sm:justify-end">
                          <span className="text-xs text-gray-400">{replyContent.length}/500</span>
                          <button
                            onClick={() =>
                              onPostReply(
                                comment.id,
                                replyingTo.replyId,
                                replyingTo.username
                              )
                            }
                            disabled={!replyContent.trim() || replyContent.length > 500 || (!!turnstileSiteKey && !turnstileToken)}
                            className="px-3 sm:px-4 py-1 bg-slate-800 hover:bg-slate-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded text-xs sm:text-sm transition-colors"
                          >
                            {t('comments.reply')}
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Liste des réponses (déjà en ordre hiérarchique) */}
                {replies?.map((reply) => {
                  // Déterminer si c'est une réponse à une autre réponse (pas directement au commentaire)
                  const isNestedReply = reply.parent_reply_id !== null && reply.parent_reply_id !== undefined;

                  return (
                    <React.Fragment key={reply.id}>
                      <motion.div
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ duration: 0.2 }}
                        className={`flex gap-2 sm:gap-3 ${isNestedReply ? 'mt-2' : ''} relative`}
                      >
                        {/* Overlay de suppression réponse */}
                        <AnimatePresence>
                          {(deletingIds.has(reply.id) || deletedIds.has(reply.id)) && (
                            <motion.div
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              exit={{ opacity: 0 }}
                              className="absolute inset-0 z-10 flex items-center justify-center bg-gray-900/80 backdrop-blur-sm rounded-lg"
                            >
                              {deletingIds.has(reply.id) ? (
                                <div className="flex items-center gap-2 text-yellow-400">
                                  <div className="w-3.5 h-3.5 border-2 border-yellow-400 border-t-transparent rounded-full animate-spin" />
                                  <span className="text-xs font-medium">{t('comments.deleting')}</span>
                                </div>
                              ) : (
                                <motion.div
                                  initial={{ scale: 0.8 }}
                                  animate={{ scale: 1 }}
                                  className="flex items-center gap-2 text-red-400"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                  <span className="text-xs font-medium">{t('comments.replyDeleted')}</span>
                                </motion.div>
                              )}
                            </motion.div>
                          )}
                        </AnimatePresence>

                        <div className="flex-shrink-0">
                          {reply.avatar ? (
                            <img
                              src={reply.avatar}
                              alt={reply.username}
                              className="w-7 h-7 sm:w-8 sm:h-8 rounded-full"
                            />
                          ) : (
                            <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-gradient-to-br from-slate-800 to-slate-900 flex items-center justify-center text-white text-xs sm:text-sm font-bold">
                              {reply.username.charAt(0).toUpperCase()}
                            </div>
                          )}
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
                            <span className="font-semibold text-white text-xs sm:text-sm truncate">{reply.username}</span>
                            {reply.is_admin === 1 && (
                              <span className="px-1.5 sm:px-2 py-0.5 bg-red-600 text-white text-[10px] sm:text-xs rounded-full whitespace-nowrap">
                                Admin
                              </span>
                            )}
                            {reply.is_vip === 1 && (
                              <span className="px-1.5 sm:px-2 py-0.5 bg-yellow-600 text-white text-[10px] sm:text-xs rounded-full whitespace-nowrap">
                                VIP
                              </span>
                            )}
                            <span className="text-[10px] sm:text-xs text-gray-400 whitespace-nowrap">{formatDate(reply.created_at)}</span>
                            {reply.parent_reply_id && reply.reply_to_username && (
                              <span className="text-[10px] sm:text-xs text-red-500 truncate">
                                → @{reply.reply_to_username}
                              </span>
                            )}
                            {reply.is_edited === 1 && (
                              <span className="text-[10px] sm:text-xs text-gray-500 whitespace-nowrap">({t('comments.edited')})</span>
                            )}
                          </div>

                          {/* Contenu de la réponse */}
                          {editingReply === reply.id ? (
                            <div className="mt-1 sm:mt-2">
                              <textarea
                                value={editContent}
                                onChange={(e) => setEditContent(e.target.value)}
                                maxLength={500}
                                className="w-full bg-gray-700/50 text-white rounded-lg p-2 sm:p-3 text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-red-600 resize-none"
                                rows={2}
                              />
                              <div className="flex items-center gap-2 mt-2 flex-wrap">
                                <SpoilerToggle
                                  checked={editIsSpoiler}
                                  onChange={setEditIsSpoiler}
                                  size="sm"
                                />
                                <button
                                  onClick={() => onEditReply(reply.id, comment.id)}
                                  className="px-2 sm:px-3 py-1 bg-slate-800 hover:bg-slate-700 text-white rounded text-[10px] sm:text-xs"
                                >
                                  {t('common.save')}
                                </button>
                                <button
                                  onClick={() => {
                                    setEditingReply(null);
                                    setEditContent('');
                                  }}
                                  className="px-2 sm:px-3 py-1 bg-gray-600 hover:bg-gray-700 text-white rounded text-[10px] sm:text-xs"
                                >
                                  {t('common.cancel')}
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="mt-1">
                              <motion.div
                                onClick={() => reply.is_spoiler === 1 && !revealedSpoilers.has(`reply-${reply.id}`) && onRevealSpoiler('reply', reply.id)}
                                initial={{ filter: reply.is_spoiler === 1 ? 'blur(8px)' : 'blur(0px)' }}
                                animate={{
                                  filter: reply.is_spoiler === 1 && !revealedSpoilers.has(`reply-${reply.id}`) ? 'blur(8px)' : 'blur(0px)'
                                }}
                                transition={{
                                  duration: 0.5,
                                  ease: 'easeOut'
                                }}
                                className={`text-gray-200 text-xs sm:text-sm break-words ${reply.is_spoiler === 1 && !revealedSpoilers.has(`reply-${reply.id}`) ? 'cursor-pointer' : ''
                                  }`}
                                title={reply.is_spoiler === 1 && !revealedSpoilers.has(`reply-${reply.id}`) ? t('comments.clickToReveal') : ''}
                                whileHover={reply.is_spoiler === 1 && !revealedSpoilers.has(`reply-${reply.id}`) ? { filter: 'blur(4px)' } : {}}
                              >
                                <ReactMarkdown remarkPlugins={mdPlugins} components={mdComponents}>
                                  {reply.content}
                                </ReactMarkdown>
                              </motion.div>
                              {reply.is_spoiler === 1 && !revealedSpoilers.has(`reply-${reply.id}`) && (
                                <motion.span
                                  initial={{ opacity: 1 }}
                                  animate={{ opacity: 1 }}
                                  exit={{ opacity: 0 }}
                                  className="inline-flex items-center gap-1 mt-1 text-[10px] sm:text-xs text-red-400"
                                >
                                  <AlertTriangle className="w-2.5 h-2.5 sm:w-3 sm:h-3" />
                                  <span className="hidden sm:inline">{t('comments.spoilerContent')}</span>
                                                    <span className="sm:hidden">{t('common.spoiler')}</span>
                                </motion.span>
                              )}
                            </div>
                          )}

                          {/* Actions de la réponse */}
                          <div className="flex items-center gap-2 sm:gap-3 mt-1 sm:mt-2 flex-wrap">
                            <button
                              onClick={() => onReaction('reply', reply.id)}
                              className={`flex items-center gap-1 transition-colors ${reply.userReaction ? 'text-red-500' : 'text-gray-400 hover:text-red-500'
                                }`}
                              disabled={!isAuthenticated}
                            >
                              <Heart className={`w-3 h-3 ${reply.userReaction ? 'fill-current' : ''}`} />
                              <span className="text-[10px] sm:text-xs">{reply.reactions}</span>
                            </button>

                            {isAuthenticated && (
                              <button
                                onClick={() => {
                                  // Si on est déjà en train de répondre à cette réponse, fermer le formulaire
                                  if (replyingTo?.commentId === comment.id && replyingTo?.replyId === reply.id) {
                                    setReplyingTo(null);
                                  } else {
                                    // Sinon, ouvrir/réafficher le formulaire de réponse
                                    setReplyingTo({
                                      commentId: comment.id,
                                      replyId: reply.id,
                                      username: reply.username
                                    });
                                    // S'assurer que les réponses sont ouvertes
                                    if (!expanded) {
                                      onToggleReplies(comment.id);
                                    }
                                  }
                                }}
                                className="text-[10px] sm:text-xs text-gray-400 hover:text-white transition-colors"
                              >
                                {t('comments.reply')}
                              </button>
                            )}

                            {(isAdmin || (profileId && profileId === reply.profile_id)) && (
                              <button
                                onClick={() => onRequestDeleteReply(reply.id, comment.id)}
                                className="text-[10px] sm:text-xs text-red-500 hover:text-red-400 transition-colors flex items-center gap-1"
                              >
                                <Trash2 className="w-2.5 h-2.5 sm:w-3 sm:h-3" />
                                <span className="hidden sm:inline">{t('common.delete')}</span>
                              </button>
                            )}

                            {isAuthenticated && profileId !== reply.profile_id && !reportedIds.has(`reply-${reply.id}`) && (
                              <button
                                onClick={() => setReportModal({ targetType: 'reply', targetId: reply.id })}
                                className="text-[10px] sm:text-xs text-gray-500 hover:text-orange-400 transition-colors flex items-center gap-1"
                              >
                                <Flag className="w-2.5 h-2.5 sm:w-3 sm:h-3" />
                                <span className="hidden sm:inline">{t('comments.report', 'Signaler')}</span>
                              </button>
                            )}
                            {reportedIds.has(`reply-${reply.id}`) && (
                              <span className="text-[10px] sm:text-xs text-orange-400/60 flex items-center gap-1">
                                <Flag className="w-2.5 h-2.5 sm:w-3 sm:h-3" />
                                <span className="hidden sm:inline">{t('comments.reported', 'Signalé')}</span>
                              </span>
                            )}
                          </div>
                        </div>
                      </motion.div>

                      {/* Formulaire de réponse pour cette réponse spécifique */}
                      <AnimatePresence initial={false}>
                        {replyingTo?.commentId === comment.id && replyingTo?.replyId === reply.id && (
                          <motion.div
                            initial={{ opacity: 0, y: -10 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{
                              opacity: 0,
                              y: -10,
                              transition: { duration: 0.15, ease: [0.4, 0, 1, 1] }
                            }}
                            transition={{
                              duration: 0.2,
                              ease: [0.4, 0, 0.2, 1]
                            }}
                            className="mt-2 sm:mt-3 ml-0 bg-gray-700/30 rounded-lg p-3 sm:p-4"
                          >
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-xs sm:text-sm text-gray-400">
                                {t('comments.replyTo')} <span className="text-red-500">@{replyingTo.username}</span>
                              </span>
                              <button
                                onClick={() => setReplyingTo(null)}
                                className="text-gray-400 hover:text-white"
                              >
                                <X className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                              </button>
                            </div>
                            <textarea
                              value={replyContent}
                              onChange={(e) => setReplyContent(e.target.value)}
                              placeholder={t('comments.writeReply')}
                              maxLength={500}
                              className="w-full bg-gray-700/50 text-white rounded-lg p-2 sm:p-3 text-sm sm:text-base focus:outline-none focus:ring-2 focus:ring-red-600 resize-none"
                              rows={2}
                            />
                            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 sm:gap-0 mt-2">
                              <SpoilerToggle
                                checked={isReplySpoiler}
                                onChange={setIsReplySpoiler}
                                size="sm"
                              />
                              <div className="flex items-center gap-2 w-full sm:w-auto justify-between sm:justify-end">
                                <span className="text-xs text-gray-400">{replyContent.length}/500</span>
                                <button
                                  onClick={() =>
                                    onPostReply(
                                      comment.id,
                                      replyingTo.replyId,
                                      replyingTo.username
                                    )
                                  }
                                  disabled={!replyContent.trim() || replyContent.length > 500 || (!!turnstileSiteKey && !turnstileToken)}
                                  className="px-3 sm:px-4 py-1 bg-slate-800 hover:bg-slate-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded text-xs sm:text-sm transition-colors"
                                >
                                  {t('comments.reply')}
                                </button>
                              </div>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </React.Fragment>
                  );
                })}

                {/* Bouton "Afficher x de plus" */}
                {repliesHasMore && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="mt-3 sm:mt-4"
                  >
                    <button
                      onClick={() => onLoadMoreReplies(comment.id)}
                      className="text-xs sm:text-sm text-gray-400 hover:text-red-500 transition-colors px-3 sm:px-4 py-1.5 sm:py-2 rounded-lg hover:bg-gray-700/50 w-full sm:w-auto text-center"
                    >
                      {t('comments.showMore', { count: (repliesTotalCount || 0) - (replies?.length || 0) })}
                    </button>
                  </motion.div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
}, (prev, next) => {
  // Bail-out: skip render if neither this comment's state nor any of the
  // shared parent state that affects ITS rendering changed.
  if (prev.isLast !== next.isLast) return false;
  // comment identity / mutation
  if (prev.comment.id !== next.comment.id) return false;
  if (prev.comment.updated_at !== next.comment.updated_at) return false;
  if (prev.comment.reactions !== next.comment.reactions) return false;
  if (prev.comment.userReaction !== next.comment.userReaction) return false;
  if (prev.comment.repliesCount !== next.comment.repliesCount) return false;
  if (prev.comment.content !== next.comment.content) return false;
  if (prev.comment.is_spoiler !== next.comment.is_spoiler) return false;
  if (prev.comment.is_edited !== next.comment.is_edited) return false;
  // user identity
  if (prev.profileId !== next.profileId) return false;
  if (prev.isAdmin !== next.isAdmin) return false;
  if (prev.isAuthenticated !== next.isAuthenticated) return false;
  // edit state — only relevant if WE are the one being edited (prev or next)
  const editingMatters =
    prev.editingComment === prev.comment.id ||
    next.editingComment === next.comment.id ||
    (prev.editingReply !== null && (prev.replies?.some(r => r.id === prev.editingReply))) ||
    (next.editingReply !== null && (next.replies?.some(r => r.id === next.editingReply)));
  if (editingMatters) {
    if (prev.editingComment !== next.editingComment) return false;
    if (prev.editingReply !== next.editingReply) return false;
    if (prev.editContent !== next.editContent) return false;
    if (prev.editIsSpoiler !== next.editIsSpoiler) return false;
  }
  // reply form state — only relevant if replyingTo targets this comment
  const replyingMatters =
    prev.replyingTo?.commentId === prev.comment.id ||
    next.replyingTo?.commentId === next.comment.id;
  if (replyingMatters) {
    if (prev.replyingTo !== next.replyingTo) return false;
    if (prev.replyContent !== next.replyContent) return false;
    if (prev.isReplySpoiler !== next.isReplySpoiler) return false;
  }
  // replies array reference
  if (prev.replies !== next.replies) return false;
  if (prev.expanded !== next.expanded) return false;
  if (prev.repliesHasMore !== next.repliesHasMore) return false;
  if (prev.repliesTotalCount !== next.repliesTotalCount) return false;
  // sets — these mutate by reference on every parent change, but we only
  // care if WE have an entry in them
  const myKey = `comment-${prev.comment.id}`;
  if (prev.deletingIds.has(prev.comment.id) !== next.deletingIds.has(next.comment.id)) return false;
  if (prev.deletedIds.has(prev.comment.id) !== next.deletedIds.has(next.comment.id)) return false;
  if (prev.revealedSpoilers.has(myKey) !== next.revealedSpoilers.has(myKey)) return false;
  if (prev.reportedIds.has(myKey) !== next.reportedIds.has(myKey)) return false;
  // for replies' membership in those sets, only check if we have replies
  if (prev.replies && prev.replies.length > 0) {
    for (const r of prev.replies) {
      if (prev.deletingIds.has(r.id) !== next.deletingIds.has(r.id)) return false;
      if (prev.deletedIds.has(r.id) !== next.deletedIds.has(r.id)) return false;
      const rk = `reply-${r.id}`;
      if (prev.revealedSpoilers.has(rk) !== next.revealedSpoilers.has(rk)) return false;
      if (prev.reportedIds.has(rk) !== next.reportedIds.has(rk)) return false;
    }
  }
  // turnstile only matters if reply form is open for this comment
  if (replyingMatters) {
    if (prev.turnstileToken !== next.turnstileToken) return false;
  }
  return true;
});
CommentItem.displayName = 'CommentItem';

const CommentsSection: React.FC<CommentsSectionProps> = ({ contentType, contentId }) => {
  const { t, i18n } = useTranslation();
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [newComment, setNewComment] = useState('');
  const [isSpoiler, setIsSpoiler] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [expandedReplies, setExpandedReplies] = useState<Set<number>>(new Set());
  const [replies, setReplies] = useState<{ [key: number]: Reply[] }>({});
  const [replyingTo, setReplyingTo] = useState<{ commentId: number; replyId?: number; username: string } | null>(null);
  const [replyContent, setReplyContent] = useState('');
  const [isReplySpoiler, setIsReplySpoiler] = useState(false);
  const [editingComment, setEditingComment] = useState<number | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editIsSpoiler, setEditIsSpoiler] = useState(false);
  const [editingReply, setEditingReply] = useState<number | null>(null);
  const [revealedSpoilers, setRevealedSpoilers] = useState<Set<string>>(new Set());
  const [deletingIds, setDeletingIds] = useState<Set<number>>(new Set());
  const [deletedIds, setDeletedIds] = useState<Set<number>>(new Set());
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: number; type: 'comment' | 'reply'; commentId?: number } | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [areCommentsHidden, setAreCommentsHidden] = useState(() => {
    return localStorage.getItem('settings_hide_comments_section') === 'true';
  });
  const [repliesPage, setRepliesPage] = useState<{ [key: number]: number }>({});
  const [repliesHasMore, setRepliesHasMore] = useState<{ [key: number]: boolean }>({});

  const [repliesTotalCount, setRepliesTotalCount] = useState<{ [key: number]: number }>({});
  const [commentLimits, setCommentLimits] = useState<{ movieCount: number; hourCount: number; movieLimit: number | null; hourLimit: number | null; isAdmin?: boolean } | null>(null);

  // Report states
  const [reportModal, setReportModal] = useState<{ targetType: 'comment' | 'reply'; targetId: number } | null>(null);
  const [reportReason, setReportReason] = useState('');
  const [reportDetails, setReportDetails] = useState('');
  const [reportSubmitting, setReportSubmitting] = useState(false);
  const [reportedIds, setReportedIds] = useState<Set<string>>(new Set());

  // Turnstile
  const [turnstileToken, setTurnstileToken] = useState('');
  const turnstileRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  // Dispense admin : pas de challenge du tout. Voir `utils/turnstileBypass.ts`.
  const turnstileBypass = useTurnstileBypass();

  const observerRef = useRef<IntersectionObserver | null>(null);
  const lastCommentRef = useRef<HTMLDivElement | null>(null);
  const commentTextareaRef = useRef<HTMLTextAreaElement>(null);
  const replyTextareaRef = useRef<HTMLTextAreaElement>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Helper pour récupérer les données du profil de manière sécurisée
  const getProfileData = () => {
    const profile = localStorage.getItem('selected_profile');
    try {
      return profile ? JSON.parse(profile) : null;
    } catch (e) {
      console.error('Erreur lors du parsing du profil:', e);
      return null;
    }
  };

  // Vérifier l'authentification et le profil
  useEffect(() => {
    const token = localStorage.getItem('auth_token');
    const profileId = localStorage.getItem('selected_profile_id');

    if (token) {
      setIsAuthenticated(true);
      if (profileId) {
        setProfileId(profileId);
      }

      // Vérifier si admin
      axios.get(`${MAIN_API}/api/admin/check`, {
        headers: { Authorization: `Bearer ${token}` }
      })
        .then(() => setIsAdmin(true))
        .catch(() => setIsAdmin(false));
    }
  }, []);

  useEffect(() => {
    const syncCommentsVisibility = () => {
      setAreCommentsHidden(localStorage.getItem('settings_hide_comments_section') === 'true');
    };

    syncCommentsVisibility();
    window.addEventListener('storage', syncCommentsVisibility);
    window.addEventListener('comments_section_visibility_changed', syncCommentsVisibility as EventListener);

    return () => {
      window.removeEventListener('storage', syncCommentsVisibility);
      window.removeEventListener('comments_section_visibility_changed', syncCommentsVisibility as EventListener);
    };
  }, []);

  // Turnstile : rendre le widget quand l'utilisateur est authentifié
  const renderTurnstile = useCallback(() => {
    if (window.turnstile && turnstileRef.current && !widgetIdRef.current) {
      widgetIdRef.current = window.turnstile.render(turnstileRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        theme: 'dark',
        callback: (token: string) => setTurnstileToken(token),
        'expired-callback': () => setTurnstileToken(''),
        'error-callback': () => setTurnstileToken(''),
      });
    }
  }, []);

  useEffect(() => {
    if (turnstileBypass === 'bypass') {
      setTurnstileToken(ADMIN_BYPASS_TOKEN);
      return;
    }
    // Statut encore inconnu : on n'affiche rien plutôt qu'un challenge à
    // retirer juste après.
    if (turnstileBypass === 'unknown') return;
    if (!isAuthenticated || !TURNSTILE_SITE_KEY) return;

    const timer = setTimeout(() => {
      if (window.turnstile) {
        renderTurnstile();
      } else {
        const interval = setInterval(() => {
          if (window.turnstile) {
            clearInterval(interval);
            renderTurnstile();
          }
        }, 200);
        // Nettoyage de l'intervalle après 10s max
        setTimeout(() => clearInterval(interval), 10000);
      }
    }, 300);

    return () => {
      clearTimeout(timer);
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
        setTurnstileToken('');
      }
    };
  }, [isAuthenticated, renderTurnstile, turnstileBypass]);

  const resetTurnstile = useCallback(() => {
    // Un dispensé n'a rien à réinitialiser : effacer le marqueur rebloquerait
    // le bouton après le premier commentaire.
    if (turnstileBypass !== 'challenge') return;

    setTurnstileToken('');
    if (widgetIdRef.current && window.turnstile) {
      window.turnstile.reset(widgetIdRef.current);
    }
  }, [turnstileBypass]);

  // Charger les commentaires
  const loadComments = useCallback(async (pageNum: number = 1) => {
    try {
      const token = localStorage.getItem('auth_token');
      const currentProfileId = localStorage.getItem('selected_profile_id');

      const response = await axios.get(
        `${MAIN_API}/api/comments/${contentType}/${contentId}`,
        {
          params: { page: pageNum, limit: 20, profileId: currentProfileId },
          headers: token ? { Authorization: `Bearer ${token}` } : {}
        }
      );

      if (pageNum === 1) {
        setComments(response.data.comments);
      } else {
        setComments(prev => [...prev, ...response.data.comments]);
      }

      setHasMore(response.data.hasMore);
      setLoading(false);

      // Délai de 0.3 secondes avant d'afficher les commentaires
      setTimeout(() => {
        setShowComments(true);
      }, 300);
    } catch (error) {
      console.error('Erreur lors du chargement des commentaires:', error);
      setLoading(false);
      setTimeout(() => {
        setShowComments(true);
      }, 300);
    }
  }, [contentType, contentId]);

  useEffect(() => {
    loadComments(1);
    fetchLimits();
  }, [loadComments]);

  // Charger les limites de commentaires
  const fetchLimits = async () => {
    try {
      const token = localStorage.getItem('auth_token');
      const currentProfileId = localStorage.getItem('selected_profile_id');
      if (!token) return;

      const response = await axios.get(`${MAIN_API}/api/comments/limits`, {
        params: { contentType, contentId, profileId: currentProfileId },
        headers: { Authorization: `Bearer ${token}` }
      });

      setCommentLimits(response.data);
    } catch (error) {
      console.error('Erreur lors de la récupération des limites:', error);
    }
  };

  // Pagination infinie — stable observer that reads latest state via refs.
  // Avoids tearing down/rebuilding the IO on every page/loading transition.
  const pageRef = useRef(page);
  const hasMoreRef = useRef(hasMore);
  const loadingRef = useRef(loading);
  useEffect(() => { pageRef.current = page; }, [page]);
  useEffect(() => { hasMoreRef.current = hasMore; }, [hasMore]);
  useEffect(() => { loadingRef.current = loading; }, [loading]);

  useEffect(() => {
    if (observerRef.current) observerRef.current.disconnect();

    observerRef.current = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && hasMoreRef.current && !loadingRef.current) {
        const nextPage = pageRef.current + 1;
        setPage(nextPage);
        loadComments(nextPage);
      }
    });

    if (lastCommentRef.current) {
      observerRef.current.observe(lastCommentRef.current);
    }

    return () => {
      if (observerRef.current) observerRef.current.disconnect();
    };
  }, [loadComments]);

  // Re-attach the IO target when the last-comment node changes (e.g. when
  // new comments are appended after pagination). Without this the observer
  // would still be watching the old "last" node.
  useEffect(() => {
    if (!observerRef.current) return;
    observerRef.current.disconnect();
    if (lastCommentRef.current) {
      observerRef.current.observe(lastCommentRef.current);
    }
  }, [comments.length]);

  // Charger les réponses d'un commentaire
  const loadReplies = async (commentId: number, page: number = 1) => {
    try {
      const token = localStorage.getItem('auth_token');
      const currentProfileId = localStorage.getItem('selected_profile_id');

      const response = await axios.get(
        `${MAIN_API}/api/comments/${commentId}/replies`,
        {
          params: { page, limit: 3, profileId: currentProfileId },
          headers: token ? { Authorization: `Bearer ${token}` } : {}
        }
      );

      const hierarchicalReplies = response.data.replies || [];

      if (page === 1) {
        // Première page : remplacer les réponses
        setReplies(prev => ({
          ...prev,
          [commentId]: hierarchicalReplies
        }));
      } else {
        // Pages suivantes : ajouter les réponses
        setReplies(prev => ({
          ...prev,
          [commentId]: [...(prev[commentId] || []), ...hierarchicalReplies]
        }));
      }

      // Mettre à jour les infos de pagination
      setRepliesPage(prev => ({
        ...prev,
        [commentId]: page
      }));

      setRepliesHasMore(prev => ({
        ...prev,
        [commentId]: response.data.hasMore
      }));

      setRepliesTotalCount(prev => ({
        ...prev,
        [commentId]: response.data.total
      }));
    } catch (error) {
      console.error('Erreur lors du chargement des réponses:', error);
    }
  };

  // Charger plus de réponses
  const loadMoreReplies = async (commentId: number) => {
    const currentPage = repliesPage[commentId] || 1;
    const nextPage = currentPage + 1;
    await loadReplies(commentId, nextPage);
  };

  // Poster un commentaire
  const handlePostComment = async () => {
    if (!newComment.trim() || newComment.length > 500) return;
    if (TURNSTILE_SITE_KEY && !turnstileToken) return;

    const token = localStorage.getItem('auth_token');
    if (!token) return;

    const profileData = getProfileData();

    // Créer un commentaire optimiste avec un ID temporaire négatif
    const optimisticComment: Comment = {
      id: -Date.now(), // ID temporaire négatif
      content_type: contentType,
      content_id: contentId,
      user_id: '',
      user_type: '',
      profile_id: profileId,
      username: profileData?.name || t('comments.you'),
      avatar: profileData?.avatar || null,
      content: newComment,
      is_spoiler: isSpoiler ? 1 : 0,
      is_vip: 0,
      is_admin: 0,
      is_edited: 0,
      created_at: Date.now(),
      deleted: 0,
      repliesCount: 0,
      reactions: 0,
      userReaction: null
    };

    // Ajouter immédiatement le commentaire (mise à jour optimiste)
    setComments(prev => [optimisticComment, ...prev]);
    const commentContent = newComment;
    const commentIsSpoiler = isSpoiler;
    setNewComment('');
    setIsSpoiler(false);

    try {
      const response = await axios.post(
        `${MAIN_API}/api/comments`,
        {
          contentType,
          contentId,
          content: commentContent,
          isSpoiler: commentIsSpoiler,
          profileId,
          turnstileToken
        },
        { headers: { Authorization: `Bearer ${token}`, ...getVipHeaders() } }
      );

      // Reset le widget Turnstile pour le prochain commentaire
      resetTurnstile();

      setComments(prev => prev.map(c =>
        c.id === optimisticComment.id ? response.data : c
      ));

      // Mettre à jour les limites après un post réussi
      fetchLimits();
    } catch (error) {
      console.error('Erreur lors de la publication du commentaire:', error);
      // En cas d'erreur, retirer le commentaire optimiste
      setComments(prev => prev.filter(c => c.id !== optimisticComment.id));
      // Restaurer le contenu pour que l'utilisateur ne perde pas son texte
      setNewComment(commentContent);
      setIsSpoiler(commentIsSpoiler);

      if (axios.isAxiosError(error) && error.response?.status === 429) {
        toast.error(error.response.data.error || t('comments.limitReached'));
      } else {
        toast.error(t('comments.publishError'));
      }
    }
  };

  // Poster une réponse
  const handlePostReply = async (commentId: number, parentReplyId?: number, replyToUsername?: string) => {
    if (!replyContent.trim() || replyContent.length > 500) return;
    if (TURNSTILE_SITE_KEY && !turnstileToken) return;

    const token = localStorage.getItem('auth_token');
    if (!token) return;

    const profileData = getProfileData();

    // Créer une réponse optimiste avec un ID temporaire négatif
    const optimisticReply: Reply = {
      id: -Date.now(), // ID temporaire négatif
      comment_id: commentId,
      parent_reply_id: parentReplyId || null,
      user_id: '',
      user_type: '',
      profile_id: profileId,
      username: profileData?.name || t('comments.you'),
      avatar: profileData?.avatar || null,
      reply_to_username: replyToUsername || null,
      content: replyContent,
      is_spoiler: isReplySpoiler ? 1 : 0,
      is_vip: 0,
      is_admin: 0,
      is_edited: 0,
      created_at: Date.now(),
      deleted: 0,
      reactions: 0,
      userReaction: null
    };

    // Ajouter immédiatement la réponse (mise à jour optimiste)
    setReplies(prev => ({
      ...prev,
      [commentId]: [...(prev[commentId] || []), optimisticReply]
    }));

    // Mettre à jour immédiatement le compteur de réponses
    setComments(prev =>
      prev.map(c =>
        c.id === commentId ? { ...c, repliesCount: c.repliesCount + 1 } : c
      )
    );

    const replyContentBackup = replyContent;
    const isReplySpoilerBackup = isReplySpoiler;
    setReplyContent('');
    setIsReplySpoiler(false);
    setReplyingTo(null);

    try {
      await axios.post(
        `${MAIN_API}/api/comments/${commentId}/replies`,
        {
          content: replyContentBackup,
          isSpoiler: isReplySpoilerBackup,
          profileId,
          parentReplyId,
          replyToUsername,
          turnstileToken
        },
        { headers: { Authorization: `Bearer ${token}`, ...getVipHeaders() } }
      );

      // Reset le widget Turnstile pour la prochaine réponse
      resetTurnstile();

      // Recharger toutes les pages de réponses actuellement chargées
      const currentPage = repliesPage[commentId] || 1;
      const totalReplies: Reply[] = [];
      const currentProfileId = localStorage.getItem('selected_profile_id');

      for (let p = 1; p <= currentPage; p++) {
        const response = await axios.get(
          `${MAIN_API}/api/comments/${commentId}/replies`,
          {
            params: { page: p, limit: 3, profileId: currentProfileId },
            headers: { Authorization: `Bearer ${token}` }
          }
        );
        totalReplies.push(...(response.data.replies || []));

        // Mettre à jour les infos de pagination avec la dernière page
        if (p === currentPage) {
          setRepliesHasMore(prev => ({
            ...prev,
            [commentId]: response.data.hasMore
          }));
          setRepliesTotalCount(prev => ({
            ...prev,
            [commentId]: response.data.total
          }));
        }
      }

      setReplies(prev => ({
        ...prev,
        [commentId]: totalReplies
      }));
    } catch (error) {
      console.error('Erreur lors de la publication de la réponse:', error);
      // En cas d'erreur, retirer la réponse optimiste
      setReplies(prev => ({
        ...prev,
        [commentId]: (prev[commentId] || []).filter(r => r.id !== optimisticReply.id)
      }));
      // Décrémenter le compteur de réponses
      setComments(prev =>
        prev.map(c =>
          c.id === commentId ? { ...c, repliesCount: c.repliesCount - 1 } : c
        )
      );
      // Restaurer le contenu
      setReplyContent(replyContentBackup);
      setIsReplySpoiler(isReplySpoilerBackup);
      setReplyingTo({ commentId, replyId: parentReplyId, username: replyToUsername || '' });
      toast.error(t('comments.replyError'));
    }
  };

  // Éditer un commentaire
  const handleEditComment = async (commentId: number) => {
    if (!editContent.trim() || editContent.length > 500) return;

    const token = localStorage.getItem('auth_token');
    if (!token) return;

    try {
      await axios.put(
        `${MAIN_API}/api/comments/${commentId}`,
        {
          content: editContent,
          isSpoiler: editIsSpoiler,
          profileId
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      setComments(prev =>
        prev.map(c =>
          c.id === commentId
            ? { ...c, content: editContent, is_spoiler: editIsSpoiler ? 1 : 0, is_edited: 1 }
            : c
        )
      );

      setEditingComment(null);
      setEditContent('');
    } catch (error) {
      console.error('Erreur lors de l\'édition du commentaire:', error);
    }
  };

  // Éditer une réponse
  const handleEditReply = async (replyId: number, commentId: number) => {
    if (!editContent.trim() || editContent.length > 500) return;

    const token = localStorage.getItem('auth_token');
    if (!token) return;

    try {
      await axios.put(
        `${MAIN_API}/api/comments/replies/${replyId}`,
        {
          content: editContent,
          isSpoiler: editIsSpoiler,
          profileId
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      setReplies(prev => ({
        ...prev,
        [commentId]: prev[commentId].map(r =>
          r.id === replyId
            ? { ...r, content: editContent, is_spoiler: editIsSpoiler ? 1 : 0, is_edited: 1 }
            : r
        )
      }));

      setEditingReply(null);
      setEditContent('');
    } catch (error) {
      console.error('Erreur lors de l\'édition de la réponse:', error);
    }
  };

  // Demande confirmation de suppression (ouvre le popup)
  const requestDeleteComment = (commentId: number) => {
    setDeleteConfirm({ id: commentId, type: 'comment' });
  };

  const requestDeleteReply = (replyId: number, commentId: number) => {
    setDeleteConfirm({ id: replyId, type: 'reply', commentId });
  };

  // Exécuter la suppression confirmée
  const executeDelete = async () => {
    if (!deleteConfirm) return;
    const { id, type, commentId } = deleteConfirm;
    setDeleteConfirm(null);

    const token = localStorage.getItem('auth_token');
    if (!token) return;

    setDeletingIds(prev => new Set(prev).add(id));

    try {
      if (type === 'comment') {
        await axios.delete(`${MAIN_API}/api/comments/${id}`, {
          headers: { Authorization: `Bearer ${token}` },
          params: { profileId }
        });

        setDeletingIds(prev => { const s = new Set(prev); s.delete(id); return s; });
        setDeletedIds(prev => new Set(prev).add(id));

        setTimeout(() => {
          setComments(prev => prev.filter(c => c.id !== id));
          setDeletedIds(prev => { const s = new Set(prev); s.delete(id); return s; });
        }, 2000);
      } else {
        await axios.delete(`${MAIN_API}/api/comments/replies/${id}`, {
          headers: { Authorization: `Bearer ${token}` },
          params: { profileId }
        });

        setDeletingIds(prev => { const s = new Set(prev); s.delete(id); return s; });
        setDeletedIds(prev => new Set(prev).add(id));

        setTimeout(() => {
          setReplies(prev => ({
            ...prev,
            [commentId!]: (prev[commentId!] || []).filter(r => r.id !== id)
          }));
          setComments(prev =>
            prev.map(c =>
              c.id === commentId ? { ...c, repliesCount: c.repliesCount - 1 } : c
            )
          );
          setDeletedIds(prev => { const s = new Set(prev); s.delete(id); return s; });
        }, 2000);
      }
    } catch (error) {
      console.error('Erreur lors de la suppression:', error);
      setDeletingIds(prev => { const s = new Set(prev); s.delete(id); return s; });
    }
  };

  // Soumettre un signalement
  const handleReport = async () => {
    if (!reportModal || !reportReason) return;
    const token = localStorage.getItem('auth_token');
    if (!token) return;

    setReportSubmitting(true);
    try {
      await axios.post(
        `${MAIN_API}/api/comments/report`,
        {
          targetType: reportModal.targetType,
          targetId: reportModal.targetId,
          reason: reportReason,
          details: reportDetails || undefined,
          profileId
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setReportedIds(prev => new Set(prev).add(`${reportModal.targetType}-${reportModal.targetId}`));
      setReportModal(null);
      setReportReason('');
      setReportDetails('');
    } catch (error: any) {
      if (error.response?.status === 409) {
        setReportedIds(prev => new Set(prev).add(`${reportModal.targetType}-${reportModal.targetId}`));
        setReportModal(null);
        setReportReason('');
        setReportDetails('');
      } else {
        console.error('Erreur lors du signalement:', error);
      }
    } finally {
      setReportSubmitting(false);
    }
  };

  const REPORT_REASONS = [
    { value: 'spam', label: t('comments.reportReasons.spam', 'Spam') },
    { value: 'harassment', label: t('comments.reportReasons.harassment', 'Insultes / Harcèlement') },
    { value: 'sexual_content', label: t('comments.reportReasons.sexualContent', 'Contenu sexuel') },
    { value: 'unmarked_spoiler', label: t('comments.reportReasons.unmarkedSpoiler', 'Spoiler non marqué') },
    { value: 'impersonation', label: t('comments.reportReasons.impersonation', "Usurpation d'identité") },
    { value: 'other', label: t('comments.reportReasons.other', 'Autre') },
  ];

  // Gérer les réactions
  const handleReaction = async (targetType: 'comment' | 'reply', targetId: number) => {
    const token = localStorage.getItem('auth_token');
    if (!token) return;

    // Déterminer l'état actuel de la réaction
    let currentReaction: boolean | null = null;
    if (targetType === 'comment') {
      const comment = comments.find(c => c.id === targetId);
      currentReaction = comment?.userReaction || false;
    } else {
      const commentId = Object.keys(replies).find(cId =>
        replies[parseInt(cId)].some(r => r.id === targetId)
      );
      if (commentId) {
        const reply = replies[parseInt(commentId)].find(r => r.id === targetId);
        currentReaction = reply?.userReaction || false;
      }
    }

    // Inverser l'état de la réaction de manière optimiste
    const newReactionState = !currentReaction;

    if (targetType === 'comment') {
      // Mise à jour optimiste pour un commentaire
      setComments(prev =>
        prev.map(c =>
          c.id === targetId
            ? {
              ...c,
              reactions: newReactionState ? c.reactions + 1 : c.reactions - 1,
              userReaction: newReactionState
            }
            : c
        )
      );
    } else {
      // Mise à jour optimiste pour une réponse
      const commentId = Object.keys(replies).find(cId =>
        replies[parseInt(cId)].some(r => r.id === targetId)
      );

      if (commentId) {
        setReplies(prev => ({
          ...prev,
          [parseInt(commentId)]: prev[parseInt(commentId)].map(r =>
            r.id === targetId
              ? {
                ...r,
                reactions: newReactionState ? r.reactions + 1 : r.reactions - 1,
                userReaction: newReactionState
              }
              : r
          )
        }));
      }
    }

    try {
      const response = await axios.post(
        `${MAIN_API}/api/comments/react`,
        { targetType, targetId, profileId },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      // Vérifier si la réponse du serveur correspond à notre état optimiste
      // Si non, corriger
      if (response.data.reacted !== newReactionState) {
        if (targetType === 'comment') {
          setComments(prev =>
            prev.map(c =>
              c.id === targetId
                ? {
                  ...c,
                  reactions: response.data.reacted ? c.reactions + 1 : c.reactions - 1,
                  userReaction: response.data.reacted
                }
                : c
            )
          );
        } else {
          const commentId = Object.keys(replies).find(cId =>
            replies[parseInt(cId)].some(r => r.id === targetId)
          );

          if (commentId) {
            setReplies(prev => ({
              ...prev,
              [parseInt(commentId)]: prev[parseInt(commentId)].map(r =>
                r.id === targetId
                  ? {
                    ...r,
                    reactions: response.data.reacted ? r.reactions + 1 : r.reactions - 1,
                    userReaction: response.data.reacted
                  }
                  : r
              )
            }));
          }
        }
      }
    } catch (error) {
      console.error('Erreur lors de la gestion de la réaction:', error);
      // En cas d'erreur, annuler la mise à jour optimiste
      if (targetType === 'comment') {
        setComments(prev =>
          prev.map(c =>
            c.id === targetId
              ? {
                ...c,
                reactions: currentReaction ? c.reactions + 1 : c.reactions - 1,
                userReaction: currentReaction
              }
              : c
          )
        );
      } else {
        const commentId = Object.keys(replies).find(cId =>
          replies[parseInt(cId)].some(r => r.id === targetId)
        );

        if (commentId) {
          setReplies(prev => ({
            ...prev,
            [parseInt(commentId)]: prev[parseInt(commentId)].map(r =>
              r.id === targetId
                ? {
                  ...r,
                  reactions: currentReaction ? r.reactions + 1 : r.reactions - 1,
                  userReaction: currentReaction
                }
                : r
            )
          }));
        }
      }
    }
  };

  // Toggle des réponses
  const toggleReplies = (commentId: number) => {
    const newExpanded = new Set(expandedReplies);
    if (newExpanded.has(commentId)) {
      newExpanded.delete(commentId);
    } else {
      newExpanded.add(commentId);
      if (!replies[commentId]) {
        loadReplies(commentId);
      }
    }
    setExpandedReplies(newExpanded);
  };

  // Révéler un spoiler
  const revealSpoiler = (type: 'comment' | 'reply', id: number) => {
    setRevealedSpoilers(prev => new Set([...prev, `${type}-${id}`]));
  };

  // Format de la date
  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 7) {
      return date.toLocaleDateString(i18n.language, { day: 'numeric', month: 'short', year: 'numeric' });
    } else if (days > 0) {
      return t('time.daysAgo', { count: days });
    } else if (hours > 0) {
      return t('time.hoursAgo', { count: hours });
    } else if (minutes > 0) {
      return t('time.minutesAgo', { count: minutes });
    } else {
      return t('time.justNow');
    }
  };

  return (
    <>
    <div className={`relative w-full max-w-5xl mx-auto px-2 sm:px-4 md:px-6 ${areCommentsHidden ? 'py-2 sm:py-3 md:py-4' : 'py-4 sm:py-6 md:py-8'}`}>
      {!areCommentsHidden ? (
      <div>
      {/* Message d'information sur les demandes d'ajouts */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-4 sm:mb-6 bg-blue-600/20 border-2 border-blue-500/50 backdrop-blur-sm rounded-xl p-3 sm:p-4"
      >
        <div className="flex items-start gap-3">
          <Info className="w-5 h-5 sm:w-6 sm:h-6 text-blue-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm sm:text-base text-gray-200 mb-3">
              <span className="font-semibold text-blue-400">{t('comments.noteTitle')}</span> {t('comments.noteContent')}
            </p>
            <div className="flex flex-wrap gap-4 items-center">
              <Link
                to="/wishboard"
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 rounded-lg transition-all border border-blue-500/30 text-sm font-medium"
              >
                <Popcorn className="w-4 h-4" />
                {t('comments.requestPage')}
              </Link>
              <a
                href="https://t.me/movix_site"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors"
              >
                Telegram
                <ExternalLink className="w-4 h-4" />
              </a>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Formulaire de commentaire */}
      {isAuthenticated ? (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8 bg-gray-800/50 backdrop-blur-sm rounded-xl p-4 sm:p-6 border border-gray-700/50"
        >
          <div className="flex gap-4">
            <div className="flex-shrink-0 hidden sm:block">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-gray-700 to-gray-900 flex items-center justify-center text-white font-bold text-lg shadow-lg">
                {getProfileData()?.name?.charAt(0).toUpperCase() || 'U'}
              </div>
            </div>
            <div className="flex-1">
              <div className="relative">
                {/* Placeholder dynamique selon le type de contenu */}
                {/* movie => Qu'as-tu pensé de ce film ? */}
                {/* tv => Qu'as-tu pensé de cette série ? */}
                <textarea
                  ref={commentTextareaRef}
                  value={newComment}
                  onChange={(e) => setNewComment(e.target.value)}
                  placeholder={contentType === 'movie' ? t('comments.moviePlaceholder') : t('comments.seriesPlaceholder')}
                  className="w-full bg-gray-900/50 text-gray-100 rounded-xl p-4 pr-12 min-h-[100px] focus:ring-2 focus:ring-blue-500/50 focus:outline-none resize-y border border-gray-700/50 placeholder-gray-500 transition-colors duration-150"
                  maxLength={500}
                />
                <div className="absolute bottom-3 right-3 text-xs text-gray-500 font-medium bg-gray-900/80 px-2 py-1 rounded-md">
                  {newComment.length}/500
                </div>
              </div>
              <MarkdownToolbar
                textareaRef={commentTextareaRef}
                value={newComment}
                onChange={setNewComment}
                maxLength={500}
              />

              {/* Affichage des limites */}
              {commentLimits && !commentLimits.isAdmin && (
                <div className="mt-3 flex flex-wrap gap-3 text-xs sm:text-sm items-center">
                  <div className="px-3 py-1.5 rounded-lg border bg-gray-700/30 border-gray-600/30 text-gray-300 font-semibold">
                    {t('comments.limit')}
                  </div>
                  <div className={`px-3 py-1.5 rounded-lg border ${commentLimits.movieLimit !== null && commentLimits.movieCount >= commentLimits.movieLimit
                    ? 'bg-red-500/10 border-red-500/30 text-red-400'
                    : 'bg-gray-700/30 border-gray-600/30 text-gray-400'
                    }`}>
                    {contentType === 'movie' ? t('comments.onThisMovie') : t('comments.onThisSeries')} : <span className="font-semibold text-gray-200">{commentLimits.movieCount}/{commentLimits.movieLimit}</span>
                  </div>
                  <div className={`px-3 py-1.5 rounded-lg border ${commentLimits.hourLimit !== null && commentLimits.hourCount >= commentLimits.hourLimit
                    ? 'bg-red-500/10 border-red-500/30 text-red-400'
                    : 'bg-gray-700/30 border-gray-600/30 text-gray-400'
                    }`}>
                    {t('comments.thisHour')} : <span className="font-semibold text-gray-200">{commentLimits.hourCount}/{commentLimits.hourLimit}</span>
                  </div>
                </div>
              )}
              {commentLimits && commentLimits.isAdmin && (
                <div className="mt-3 flex flex-wrap gap-3 text-xs sm:text-sm items-center">
                  <div className="px-3 py-1.5 rounded-lg border bg-red-600/20 border-red-500/30 text-red-400 font-semibold">
                    👑 {t('comments.adminNoLimit')}
                  </div>
                </div>
              )}

              {/* Widget Turnstile — masqué pour les dispensés */}
              {TURNSTILE_SITE_KEY && turnstileBypass === 'challenge' && (
                <div className="mt-4">
                  <p className="text-xs text-gray-400 mb-2">{t('comments.turnstileNotice')}</p>
                  <div className="overflow-hidden w-full" style={{ maxWidth: '100%' }}>
                    <div ref={turnstileRef} className="origin-left scale-[0.85] sm:scale-100" />
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between mt-4">
                <SpoilerToggle checked={isSpoiler} onChange={setIsSpoiler} />

                <button
                  onClick={handlePostComment}
                  disabled={!newComment.trim() || (TURNSTILE_SITE_KEY && !turnstileToken) || (commentLimits && !commentLimits.isAdmin ? (commentLimits.movieLimit !== null && commentLimits.movieCount >= commentLimits.movieLimit) || (commentLimits.hourLimit !== null && commentLimits.hourCount >= commentLimits.hourLimit) : false)}
                  className="bg-gradient-to-r from-slate-800 to-slate-900 hover:from-slate-700 hover:to-slate-900 text-white px-6 py-2.5 rounded-lg font-medium transition-all duration-200 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-black/30 hover:shadow-black/40 transform hover:-translate-y-0.5 active:translate-y-0"
                >
                  <Send className="w-4 h-4" />
                  <span>{t('comments.publish')}</span>
                </button>
              </div>
            </div>
          </div>
        </motion.div>
      ) : (

        <div className="mb-4 sm:mb-6 md:mb-8 bg-gray-800/70 rounded-xl p-4 sm:p-6 text-center text-gray-400 text-sm sm:text-base">
          {t('comments.loginToComment')}
        </div>
      )
      }

      {/* Liste des commentaires */}
      <div className="space-y-4 sm:space-y-6">
        {/* Loading skeleton - affiché uniquement lors du chargement initial */}
        {loading && comments.length === 0 && (
          <div className="space-y-4 sm:space-y-6">
            {[...Array(3)].map((_, index) => (
              <CommentSkeleton key={`skeleton-${index}`} />
            ))}
          </div>
        )}

        <AnimatePresence mode="popLayout">
          {showComments && comments.map((comment, index) => (
            <CommentItem
              key={comment.id}
              comment={comment}
              isLast={index === comments.length - 1}
              lastCommentRef={lastCommentRef}
              isAuthenticated={isAuthenticated}
              isAdmin={isAdmin}
              profileId={profileId}
              editingComment={editingComment}
              editContent={editContent}
              editIsSpoiler={editIsSpoiler}
              editingReply={editingReply}
              editTextareaRef={editTextareaRef}
              replyingTo={replyingTo}
              replyContent={replyContent}
              isReplySpoiler={isReplySpoiler}
              replyTextareaRef={replyTextareaRef}
              replies={replies[comment.id]}
              expanded={expandedReplies.has(comment.id)}
              repliesHasMore={!!repliesHasMore[comment.id]}
              repliesTotalCount={repliesTotalCount[comment.id] || 0}
              deletingIds={deletingIds}
              deletedIds={deletedIds}
              revealedSpoilers={revealedSpoilers}
              reportedIds={reportedIds}
              turnstileToken={turnstileToken}
              turnstileSiteKey={TURNSTILE_SITE_KEY}
              t={t as (key: string, opts?: unknown) => string}
              formatDate={formatDate}
              onReaction={handleReaction}
              onToggleReplies={toggleReplies}
              onRevealSpoiler={revealSpoiler}
              onRequestDeleteComment={requestDeleteComment}
              onRequestDeleteReply={requestDeleteReply}
              onPostReply={handlePostReply}
              onEditComment={handleEditComment}
              onEditReply={handleEditReply}
              onLoadMoreReplies={loadMoreReplies}
              setEditingComment={setEditingComment}
              setEditContent={setEditContent}
              setEditIsSpoiler={setEditIsSpoiler}
              setEditingReply={setEditingReply}
              setReplyingTo={setReplyingTo}
              setReplyContent={setReplyContent}
              setIsReplySpoiler={setIsReplySpoiler}
              setReportModal={setReportModal}
            />
          ))}
        </AnimatePresence>

        {/* Aucun commentaire */}
        {!loading && comments.length === 0 && (
          <div className="text-center py-8 sm:py-12 text-gray-400 text-sm sm:text-base px-4">
            {t('comments.noComments')}
          </div>
        )}
      </div>

      </div>
      ) : (
        <div className="flex items-center justify-center px-1 py-2 sm:px-2 sm:py-3">
          <motion.div
            initial={{ opacity: 0, y: 18, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="relative w-full max-w-2xl"
          >
            <div className="absolute left-1/2 top-1/2 h-48 w-48 -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-500/10 blur-3xl" />

            <div className="relative overflow-hidden rounded-[30px] border border-white/10 bg-[linear-gradient(135deg,rgba(255,255,255,0.08),rgba(255,255,255,0.02))] p-[1px] shadow-[0_30px_90px_rgba(0,0,0,0.45)]">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.16),transparent_35%)] opacity-80" />

              <div className="relative rounded-[29px] border border-white/5 bg-slate-950/92 px-6 py-7 text-center sm:px-8 sm:py-8">
                <motion.div
                  initial={{ scale: 0.9, opacity: 0.85 }}
                  animate={{ scale: [0.98, 1.04, 1], opacity: 1 }}
                  transition={{ duration: 0.55, ease: 'easeOut' }}
                  className="relative mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-blue-400/20 bg-gradient-to-br from-blue-500/12 via-slate-900/80 to-violet-500/12 shadow-[0_12px_40px_rgba(37,99,235,0.2)]"
                >
                  <div className="absolute inset-0 rounded-2xl bg-[radial-gradient(circle,rgba(96,165,250,0.14),transparent_60%)]" />
                  <MessageCircle className="relative h-7 w-7 text-blue-100" />
                </motion.div>

                <div className="mb-3 inline-flex items-center rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-blue-200/80">
                  {t('settings.hideCommentsSection')}
                </div>

                <p className="text-xl font-semibold tracking-tight text-white sm:text-2xl">
                  {t('comments.sectionDisabledTitle')}
                </p>

                <p className="mx-auto mt-3 max-w-xl text-sm leading-7 text-slate-300 sm:text-base">
                  {t('comments.sectionDisabledDesc')}
                </p>

                <p className="mx-auto mt-2 max-w-lg text-xs leading-6 text-slate-400 sm:text-sm">
                  {t('settings.hideCommentsSectionDesc')}
                </p>

                <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
                  <Link
                    to="/settings"
                    className="inline-flex items-center gap-2 rounded-full border border-blue-400/20 bg-blue-500/10 px-4 py-2.5 text-sm font-medium text-blue-100 transition-all hover:border-blue-300/35 hover:bg-blue-500/15 hover:text-white"
                  >
                    <span>{t('nav.settings')}</span>
                    <ExternalLink className="h-4 w-4" />
                  </Link>

                  <div className="inline-flex items-center rounded-full border border-white/8 bg-white/[0.04] px-4 py-2 text-xs text-slate-400 sm:text-sm">
                    {contentType === 'movie' ? t('comments.onThisMovie') : t('comments.onThisSeries')}
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </div >

    {/* Popup de confirmation de suppression */}
    {createPortal(
      <AnimatePresence mode="wait">
        {deleteConfirm && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-[100000]"
            onClick={(e) => { if (e.target === e.currentTarget) setDeleteConfirm(null); }}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 10 }}
              transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
              className="bg-gray-900 rounded-2xl p-6 max-w-sm w-full border border-gray-700/50 shadow-2xl"
            >
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center">
                  <Trash2 className="w-5 h-5 text-red-500" />
                </div>
                <h3 className="text-lg font-bold text-white">
                  {deleteConfirm.type === 'comment' ? t('comments.deleteConfirm') : t('comments.deleteReplyConfirm')}
                </h3>
              </div>

              <p className="text-sm text-gray-400 mb-6">
                {t('comments.deleteIrreversible')}
              </p>

              <div className="flex gap-3">
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => setDeleteConfirm(null)}
                  className="flex-1 px-4 py-2.5 bg-gray-800 hover:bg-gray-700 text-white rounded-xl font-medium transition-colors text-sm"
                >
                  {t('common.cancel')}
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={executeDelete}
                  className="flex-1 px-4 py-2.5 bg-red-600 hover:bg-red-500 text-white rounded-xl font-medium transition-colors text-sm flex items-center justify-center gap-2"
                >
                  <Trash2 className="w-4 h-4" />
                  {t('common.delete')}
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>,
      getOverlayPortalRoot()
    )}
    {/* Modal de signalement */}
    {createPortal(
      <AnimatePresence mode="wait">
        {reportModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-[100000]"
            onClick={(e) => { if (e.target === e.currentTarget) { setReportModal(null); setReportReason(''); setReportDetails(''); } }}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 10 }}
              transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
              className="bg-gray-900 rounded-2xl p-6 max-w-md w-full border border-gray-700/50 shadow-2xl"
            >
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-full bg-orange-500/10 flex items-center justify-center">
                  <Flag className="w-5 h-5 text-orange-500" />
                </div>
                <h3 className="text-lg font-bold text-white">
                  {t('comments.reportTitle', 'Signaler ce contenu')}
                </h3>
              </div>

              <div className="space-y-3 mb-5">
                {REPORT_REASONS.map((r) => (
                  <button
                    key={r.value}
                    onClick={() => setReportReason(r.value)}
                    className={`w-full text-left px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
                      reportReason === r.value
                        ? 'bg-orange-600/20 text-orange-400 border border-orange-500/50'
                        : 'bg-gray-800 text-gray-300 border border-gray-700/50 hover:bg-gray-700'
                    }`}
                  >
                    {r.label}
                  </button>
                ))}
              </div>

              <textarea
                value={reportDetails}
                onChange={(e) => setReportDetails(e.target.value.slice(0, 500))}
                placeholder={t('comments.reportDetailsPlaceholder', 'Détails supplémentaires (optionnel)...')}
                className="w-full bg-gray-800 text-white text-sm rounded-xl px-4 py-3 border border-gray-700/50 focus:border-orange-500/50 focus:outline-none resize-none mb-5"
                rows={3}
              />

              <div className="flex gap-3">
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => { setReportModal(null); setReportReason(''); setReportDetails(''); }}
                  className="flex-1 px-4 py-2.5 bg-gray-800 hover:bg-gray-700 text-white rounded-xl font-medium transition-colors text-sm"
                >
                  {t('common.cancel')}
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={handleReport}
                  disabled={!reportReason || reportSubmitting}
                  className="flex-1 px-4 py-2.5 bg-orange-600 hover:bg-orange-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-xl font-medium transition-colors text-sm flex items-center justify-center gap-2"
                >
                  <Flag className="w-4 h-4" />
                  {reportSubmitting ? t('common.loading') : t('comments.reportSubmit', 'Signaler')}
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>,
      getOverlayPortalRoot()
    )}
    </>
  );
};

export default CommentsSection;
