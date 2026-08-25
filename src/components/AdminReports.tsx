import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { toast as sonnerToast } from 'sonner';
import {
    Flag, Trash2, Loader2, RefreshCw, CheckCircle, XCircle, MessageSquare,
    List, Film, Tv, Clock, User, AlertCircle, Scissors
} from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from './ui/select';
import ReusableModal from './ui/reusable-modal';
import { getTmdbLanguage } from '../i18n';

const MAIN_API = import.meta.env.VITE_MAIN_API;

interface ReportTarget {
    id?: number;
    content?: string;
    content_id?: string;
    content_type?: string;
    username?: string;
    user_id?: string;
    authorUsername?: string;
    authorAvatar?: string;
    name?: string;
    share_code?: string;
    created_at?: number;
}

interface Report {
    id: number;
    reporter_user_id: string;
    reporter_user_type: string;
    reporter_profile_id: string;
    target_type: 'comment' | 'reply' | 'shared_list' | 'segment';
    target_id: string;
    reason: string;
    details: string | null;
    status: 'pending' | 'resolved' | 'dismissed';
    resolved_by: string | null;
    resolved_at: number | null;
    created_at: number;
    report_count: number;
    reporter: { username: string; avatar: string | null };
    target: ReportTarget;
}

interface ReportStats {
    total: number;
    pending: number;
    resolved: number;
    dismissed: number;
    comments: number;
    lists: number;
    /** Propositions de séquence signalées depuis le lecteur. */
    segments: number;
}

const REASON_LABELS: Record<string, { labelKey: string; color: string }> = {
    spam: { labelKey: 'admin.reasonSpam', color: 'bg-gray-500' },
    harassment: { labelKey: 'admin.reasonHarassment', color: 'bg-red-500' },
    sexual_content: { labelKey: 'admin.reasonSexualContent', color: 'bg-pink-500' },
    unmarked_spoiler: { labelKey: 'admin.reasonUnmarkedSpoiler', color: 'bg-yellow-500' },
    impersonation: { labelKey: 'admin.reasonImpersonation', color: 'bg-purple-500' },
    other: { labelKey: 'admin.reasonOther', color: 'bg-blue-500' },
    // Réservé aux propositions de séquence : des bornes qui ne correspondent
    // à rien dans l'épisode.
    wrong_timestamp: { labelKey: 'admin.reasonWrongTimestamp', color: 'bg-orange-500' },
};

const DEFAULT_STATS: ReportStats = { total: 0, pending: 0, resolved: 0, dismissed: 0, comments: 0, lists: 0, segments: 0 };

const AdminReports: React.FC = () => {
    const { t, i18n } = useTranslation();
    const [reports, setReports] = useState<Report[]>([]);
    const [stats, setStats] = useState<ReportStats>(DEFAULT_STATS);
    const [loading, setLoading] = useState(true);
    const [fetchError, setFetchError] = useState<string | null>(null);
    const [statusFilter, setStatusFilter] = useState('pending');
    const [typeFilter, setTypeFilter] = useState('all');
    const [page, setPage] = useState(1);
    const [hasMore, setHasMore] = useState(false);
    const [submitting, setSubmitting] = useState<number | null>(null);

    // Resolve modal
    const [resolveModal, setResolveModal] = useState<Report | null>(null);

    // TMDB cache — ref to avoid re-triggering useCallback
    const [tmdbCache, setTmdbCache] = useState<Record<string, { title: string; poster_path: string | null }>>({});
    const tmdbCacheRef = useRef(tmdbCache);
    tmdbCacheRef.current = tmdbCache;

    const authToken = localStorage.getItem('auth_token');

    const fetchTmdbForReports = (fetchedReports: Report[]) => {
        const contentIds = new Set<string>();
        fetchedReports.forEach((r) => {
            const cid = r.target?.content_id;
            const ctype = r.target?.content_type;
            if (cid && ctype && !tmdbCacheRef.current[`${ctype}-${cid}`]) {
                contentIds.add(`${ctype}:${cid}`);
            }
        });
        contentIds.forEach(async (key) => {
            const [ctype, cid] = key.split(':');
            try {
                const tmdbType = ctype === 'tv' ? 'tv' : 'movie';
                const resp = await fetch(`https://api.themoviedb.org/3/${tmdbType}/${cid}?api_key=${import.meta.env.VITE_TMDB_API_KEY}&language=${getTmdbLanguage()}`);
                if (resp.ok) {
                    const tmdb = await resp.json();
                    setTmdbCache((prev) => ({ ...prev, [`${ctype}-${cid}`]: { title: tmdb.title || tmdb.name, poster_path: tmdb.poster_path } }));
                }
            } catch { /* ignore */ }
        });
    };

    const fetchReports = useCallback(async (pageNum = 1) => {
        if (!authToken) return;
        setLoading(true);
        try {
            const response = await fetch(
                `${MAIN_API}/api/comments/admin/reports?status=${statusFilter}&targetType=${typeFilter}&page=${pageNum}&limit=30`,
                { headers: { Authorization: `Bearer ${authToken}` } }
            );
            if (!response.ok) throw new Error(`Erreur ${response.status}: ${response.statusText}`);
            const data = await response.json();
            const fetchedReports: Report[] = data.reports || [];
            setReports(pageNum === 1 ? fetchedReports : (prev) => [...prev, ...fetchedReports]);
            setStats(data.stats || DEFAULT_STATS);
            setHasMore(data.hasMore || false);
            setPage(pageNum);
            setFetchError(null);
            fetchTmdbForReports(fetchedReports);
        } catch (error: any) {
            console.error('Erreur fetch reports:', error);
            setFetchError(error.message || 'Impossible de charger les signalements');
        } finally {
            setLoading(false);
        }
    }, [authToken, statusFilter, typeFilter]);

    useEffect(() => { fetchReports(1); }, [fetchReports]);

    const handleResolve = async (report: Report, shouldDeleteContent: boolean) => {
        if (!authToken) return;
        setSubmitting(report.id);
        try {
            const response = await fetch(`${MAIN_API}/api/comments/admin/reports/${report.id}/resolve`, {
                method: 'PUT',
                headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ deleteContent: shouldDeleteContent })
            });
            if (response.ok) {
                setReports((prev) => prev.filter((r) => !(r.target_type === report.target_type && r.target_id === report.target_id)));
                setStats((prev) => ({ ...prev, pending: Math.max(0, prev.pending - report.report_count), resolved: prev.resolved + report.report_count }));
                sonnerToast.success(shouldDeleteContent ? t('admin.reportResolvedWithDeletion') : t('admin.reportResolved'));
            }
        } catch (error) {
            console.error('Erreur resolve:', error);
            sonnerToast.error(t('admin.reportResolveError'));
        } finally {
            setSubmitting(null);
            setResolveModal(null);
        }
    };

    const handleDismiss = async (report: Report) => {
        if (!authToken) return;
        setSubmitting(report.id);
        try {
            const response = await fetch(`${MAIN_API}/api/comments/admin/reports/${report.id}/dismiss`, {
                method: 'PUT',
                headers: { Authorization: `Bearer ${authToken}` }
            });
            if (response.ok) {
                setReports((prev) => prev.filter((r) => !(r.target_type === report.target_type && r.target_id === report.target_id)));
                setStats((prev) => ({ ...prev, pending: Math.max(0, prev.pending - report.report_count), dismissed: prev.dismissed + report.report_count }));
                sonnerToast.success(t('admin.reportDismissed'));
            }
        } catch (error) {
            console.error('Erreur dismiss:', error);
            sonnerToast.error(t('admin.reportDismissError'));
        } finally {
            setSubmitting(null);
        }
    };

    const formatDate = (timestamp: number) => {
        const date = new Date(timestamp);
        return date.toLocaleDateString(i18n.resolvedLanguage || i18n.language || 'fr', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    };

    const getTargetTypeIcon = (type: string) => {
        switch (type) {
            case 'comment': return <MessageSquare className="w-4 h-4" />;
            case 'reply': return <MessageSquare className="w-4 h-4" />;
            case 'shared_list': return <List className="w-4 h-4" />;
            case 'segment': return <Scissors className="w-4 h-4" />;
            default: return <Flag className="w-4 h-4" />;
        }
    };

    const getTargetTypeLabel = (type: string) => {
        switch (type) {
            case 'comment': return t('admin.comments');
            case 'reply': return t('admin.replies');
            case 'shared_list': return t('admin.sharedLists');
            case 'segment': return t('admin.segments');
            default: return type;
        }
    };

    // Group reports by target to show count
    const groupedReports = React.useMemo(() => {
        const seen = new Set<string>();
        return (reports || []).filter((r) => {
            const key = `${r.target_type}-${r.target_id}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }, [reports]);

    return (
        <div className="space-y-6">
            {/* Stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-orange-500/10 border border-orange-500/20 rounded-xl p-4 text-center">
                    <div className="text-2xl font-bold text-orange-400">{stats.pending}</div>
                    <div className="text-xs text-gray-400 mt-1">{t('admin.pending')}</div>
                </div>
                <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-4 text-center">
                    <div className="text-2xl font-bold text-green-400">{stats.resolved}</div>
                    <div className="text-xs text-gray-400 mt-1">{t('admin.resolvedPlural')}</div>
                </div>
                <div className="bg-gray-500/10 border border-gray-500/20 rounded-xl p-4 text-center">
                    <div className="text-2xl font-bold text-gray-400">{stats.dismissed}</div>
                    <div className="text-xs text-gray-400 mt-1">{t('admin.rejectedPlural')}</div>
                </div>
                <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-4 text-center">
                    <div className="text-2xl font-bold text-blue-400">{stats.total}</div>
                    <div className="text-xs text-gray-400 mt-1">Total</div>
                </div>
            </div>

            {/* Filters */}
            <div className="flex flex-wrap gap-3 items-center">
                <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v)}>
                    <SelectTrigger className="w-[160px] bg-gray-800 border-gray-700">
                        <SelectValue placeholder={t('admin.status')} />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="pending">{t('admin.pending')}</SelectItem>
                        <SelectItem value="resolved">{t('admin.resolvedPlural')}</SelectItem>
                        <SelectItem value="dismissed">{t('admin.rejectedPlural')}</SelectItem>
                        <SelectItem value="all">{t('common.all')}</SelectItem>
                    </SelectContent>
                </Select>

                <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v)}>
                    <SelectTrigger className="w-[180px] bg-gray-800 border-gray-700">
                        <SelectValue placeholder={t('admin.type')} />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">{t('admin.allTypes')}</SelectItem>
                        <SelectItem value="comment">{t('admin.comments')}</SelectItem>
                        <SelectItem value="reply">{t('admin.replies')}</SelectItem>
                        <SelectItem value="shared_list">{t('admin.sharedLists')}</SelectItem>
                        <SelectItem value="segment">{t('admin.segments')}</SelectItem>
                    </SelectContent>
                </Select>

                <Button variant="secondary" onClick={() => fetchReports(1)} disabled={loading}>
                    <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
                    {t('admin.refresh', 'Actualiser')}
                </Button>
            </div>

            {/* Error message */}
            {fetchError && (
                <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-lg flex items-start gap-3">
                    <AlertCircle className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
                    <div>
                        <p className="text-sm text-red-200 font-medium">{t('errors.loadingFailed')}</p>
                        <p className="text-xs text-red-100/70">{fetchError}</p>
                        <p className="text-xs text-red-100/50 mt-1">{t('admin.reportsApiHint')}</p>
                    </div>
                </div>
            )}

            {/* Reports List */}
            {loading ? (
                <div className="flex justify-center py-12">
                    <Loader2 className="w-8 h-8 text-orange-500 animate-spin" />
                </div>
            ) : groupedReports.length === 0 && !fetchError ? (
                <div className="text-center py-12 text-gray-500">
                    <Flag className="w-12 h-12 mx-auto mb-3 opacity-30" />
                    <p>{statusFilter === 'pending' ? t('admin.noPendingReports') : t('admin.noReportsFound')}</p>
                </div>
            ) : (
                <div className="space-y-3">
                    <AnimatePresence initial={false}>
                        {groupedReports.map((report) => {
                            const reasonInfo = REASON_LABELS[report.reason] || REASON_LABELS.other;
                            const tmdbData = report.target?.content_id ? tmdbCache[`${report.target.content_type}-${report.target.content_id}`] : null;

                            return (
                                <motion.div
                                    key={`${report.target_type}-${report.target_id}-${report.id}`}
                                    initial={{ opacity: 0, y: 10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, x: -20, transition: { duration: 0.15 } }}
                                    className="bg-white/5 border border-white/10 rounded-xl p-4 hover:border-white/20 transition-colors"
                                >
                                    <div className="flex flex-col lg:flex-row lg:items-start gap-4">
                                        {/* TMDB poster */}
                                        {tmdbData?.poster_path && (
                                            <div className="flex-shrink-0 hidden lg:block">
                                                <img
                                                    src={`https://image.tmdb.org/t/p/w92${tmdbData.poster_path}`}
                                                    alt=""
                                                    className="w-12 h-18 rounded-lg object-cover"
                                                />
                                            </div>
                                        )}

                                        <div className="flex-1 min-w-0 space-y-3">
                                            {/* Header */}
                                            <div className="flex flex-wrap items-center gap-2">
                                                <div className="flex items-center gap-1.5 text-white/50">
                                                    {getTargetTypeIcon(report.target_type)}
                                                    <span className="text-xs font-medium">{getTargetTypeLabel(report.target_type)}</span>
                                                </div>

                                                <Badge className={`${reasonInfo.color} text-white text-[10px] px-2 py-0.5`}>
                                                    {t(reasonInfo.labelKey)}
                                                </Badge>

                                                {report.report_count > 1 && (
                                                    <Badge className="bg-red-500/20 text-red-400 text-[10px] px-2 py-0.5 border border-red-500/30">
                                                        {t('admin.reportCountPlural', { count: report.report_count })}
                                                    </Badge>
                                                )}

                                                {report.status !== 'pending' && (
                                                    <Badge className={`text-[10px] px-2 py-0.5 ${report.status === 'resolved' ? 'bg-green-500/20 text-green-400' : 'bg-white/10 text-white/50'}`}>
                                                        {report.status === 'resolved' ? t('admin.resolvedStatus') : t('admin.rejectedStatus')}
                                                    </Badge>
                                                )}

                                                {tmdbData && (
                                                    <span className="text-xs text-white/40 flex items-center gap-1">
                                                        {report.target?.content_type === 'tv' ? <Tv className="w-3 h-3" /> : <Film className="w-3 h-3" />}
                                                        {tmdbData.title}
                                                    </span>
                                                )}
                                            </div>

                                            {/* Reported content */}
                                            {report.target?.content && (
                                                <div className="bg-white/5 rounded-lg p-3 border border-white/10">
                                                    <div className="flex items-center gap-2 mb-1.5">
                                                        {report.target.authorAvatar && (
                                                            <img src={report.target.authorAvatar} alt="" className="w-5 h-5 rounded-full" />
                                                        )}
                                                        <span className="text-xs font-medium text-white">{report.target.authorUsername || report.target.username}</span>
                                                    </div>
                                                    <p className="text-sm text-white/70 line-clamp-3 break-words">{report.target.content}</p>
                                                </div>
                                            )}

                                            {/* Shared list info */}
                                            {report.target_type === 'shared_list' && report.target?.name && (
                                                <div className="bg-white/5 rounded-lg p-3 border border-white/10">
                                                    <div className="flex items-center gap-2">
                                                        <List className="w-4 h-4 text-white opacity-50" />
                                                        <span className="text-sm font-medium text-white">{report.target.name}</span>
                                                        {report.target.share_code && (
                                                            <span className="text-xs text-white/40">#{report.target.share_code}</span>
                                                        )}
                                                    </div>
                                                </div>
                                            )}

                                            {/* Report details */}
                                            {report.details && (
                                                <p className="text-xs text-white/50 italic">&laquo; {report.details} &raquo;</p>
                                            )}

                                            {/* Reporter + date */}
                                            <div className="flex flex-wrap items-center gap-3 text-xs text-white/40">
                                                <span className="flex items-center gap-1">
                                                    <User className="w-3 h-3" />
                                                    {t('admin.reportedBy')} <span className="text-white/70">{report.reporter?.username || t('common.unknown')}</span>
                                                </span>
                                                <span className="flex items-center gap-1">
                                                    <Clock className="w-3 h-3" />
                                                    {formatDate(report.created_at)}
                                                </span>
                                            </div>
                                        </div>

                                        {/* Actions */}
                                        {report.status === 'pending' && (
                                            <div className="flex lg:flex-col gap-2 flex-shrink-0">
                                                <Button
                                                    size="sm"
                                                    variant="destructive"
                                                    onClick={() => setResolveModal(report)}
                                                    disabled={submitting === report.id}
                                                >
                                                    {submitting === report.id ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Trash2 className="w-3 h-3 mr-1" />}
                                                    {t('common.delete')}
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    onClick={() => handleDismiss(report)}
                                                    disabled={submitting === report.id}
                                                >
                                                    {submitting === report.id ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <XCircle className="w-3 h-3 mr-1" />}
                                                    {t('common.ignore')}
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    onClick={() => handleResolve(report, false)}
                                                    disabled={submitting === report.id}
                                                    className="border-green-600/50 text-green-400 hover:bg-green-600/10"
                                                >
                                                    {submitting === report.id ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <CheckCircle className="w-3 h-3 mr-1" />}
                                                    {t('admin.keepContent')}
                                                </Button>
                                            </div>
                                        )}
                                    </div>
                                </motion.div>
                            );
                        })}
                    </AnimatePresence>

                    {hasMore && (
                        <div className="flex justify-center pt-4">
                            <Button
                                variant="outline"
                                onClick={() => fetchReports(page + 1)}
                                className="bg-gray-800 border-gray-700"
                            >
                                {t('common.seeMore')}
                            </Button>
                        </div>
                    )}
                </div>
            )}

            {/* Delete confirmation modal - same pattern as AdminComments */}
            <ReusableModal
                isOpen={!!resolveModal}
                onClose={() => setResolveModal(null)}
                title={t('admin.deleteReportedContent')}
                className="max-w-md"
            >
                <div className="space-y-6">
                    <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-lg flex items-start gap-3">
                        <AlertCircle className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
                        <div>
                            <p className="text-sm text-red-200 font-medium">{t('admin.irreversibleAction')}</p>
                            <p className="text-xs text-red-100/70">
                                {t('admin.deleteReportedContentDesc')}
                            </p>
                        </div>
                    </div>

                    {resolveModal?.target?.content && (
                        <div className="bg-white/5 p-3 rounded-lg border border-white/10">
                            <p className="text-xs text-white/50 mb-1">
                                {resolveModal.target.authorUsername || resolveModal.target.username} :
                            </p>
                            <p className="text-sm italic text-white/80">"{resolveModal.target.content}"</p>
                        </div>
                    )}

                    {resolveModal?.target_type === 'shared_list' && resolveModal?.target?.name && (
                        <div className="bg-white/5 p-3 rounded-lg border border-white/10 flex items-center gap-2">
                            <List className="w-4 h-4 text-white opacity-50" />
                            <p className="text-sm text-white/80">{resolveModal.target.name}</p>
                        </div>
                    )}

                    <div className="flex justify-end gap-2 pt-4 border-t border-white/10">
                        <Button variant="ghost" onClick={() => setResolveModal(null)}>
                            {t('common.cancel')}
                        </Button>
                        <Button
                            variant="destructive"
                            onClick={() => resolveModal && handleResolve(resolveModal, true)}
                            disabled={submitting !== null}
                        >
                            {submitting !== null ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Trash2 className="h-4 w-4 mr-2" />}
                            {t('admin.deletePermanently')}
                        </Button>
                    </div>
                </div>
            </ReusableModal>
        </div>
    );
};

export default AdminReports;
