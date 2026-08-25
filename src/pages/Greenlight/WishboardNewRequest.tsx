import React, { useState, useCallback, useEffect, memo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { PrefetchLink as Link } from '@/routing/PrefetchLink';
import { useTranslation } from 'react-i18next';
import {
    ArrowLeft, ArrowRight, Film, Tv, Calendar, Search,
    Check, Loader2, Zap, AlertCircle
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { getVipHeaders } from '../../utils/vipUtils';


import BlurText from '../../components/ui/blur-text';
import ShinyText from '../../components/ui/shiny-text';
import AnimatedBorderCard from '../../components/ui/animated-border-card';
import { SquareBackground } from '../../components/ui/square-background';
import { getTmdbLanguage } from '../../i18n';
import { getOverlayPortalRoot } from '@/utils/overlayPortal';

interface TmdbResult {
    id: number;
    title?: string;
    name?: string;
    poster_path: string | null;
    backdrop_path?: string | null;
    release_date?: string;
    first_air_date?: string;
    overview: string;
    media_type?: 'movie' | 'tv';
    number_of_seasons?: number;
}

type ContentType = 'movie' | 'tv' | 'season';
type Step = 1 | 2 | 3;

// ========================================
// Season Selector Modal Component
// Based on AvatarSelector pattern with portal, fade animations, and optimizations
// ========================================
interface SeasonSelectorModalProps {
    isOpen: boolean;
    seasons: number[];
    contentTitle: string;
    onSelectSeason: (season: number) => void;
    onClose: () => void;
}

const SeasonSelectorModal: React.FC<SeasonSelectorModalProps> = memo(({
    isOpen,
    seasons,
    contentTitle,
    onSelectSeason,
    onClose
}) => {
    const { t } = useTranslation();
    const [visible, setVisible] = useState(false);

    // Handle visibility with simple fade
    useEffect(() => {
        if (isOpen) {
            // Small delay to trigger CSS transition
            requestAnimationFrame(() => setVisible(true));
        } else {
            setVisible(false);
        }
    }, [isOpen]);

    // Disable body scroll when modal is open
    useEffect(() => {
        if (!isOpen) return;
        const originalOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = originalOverflow;
        };
    }, [isOpen]);

    // Handle ESC key to close
    useEffect(() => {
        if (!isOpen) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') handleClose();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen]);

    const handleClose = useCallback(() => {
        setVisible(false);
        setTimeout(onClose, 150);
    }, [onClose]);

    const handleSeasonClick = useCallback((season: number) => {
        setVisible(false);
        setTimeout(() => onSelectSeason(season), 100);
    }, [onSelectSeason]);

    if (!isOpen) return null;

    const modalContent = (
        <div
            className={`fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-[100000] transition-opacity duration-150 ${visible ? 'opacity-100' : 'opacity-0'}`}
            style={{ willChange: 'opacity' }}
            onClick={(e) => {
                if (e.target === e.currentTarget) handleClose();
            }}
        >
            <div
                className={`bg-[#151515] border border-white/10 rounded-2xl p-6 max-w-md w-full transition-transform duration-150 ${visible ? 'scale-100' : 'scale-95'}`}
                style={{ willChange: 'transform' }}
            >
                {/* Header */}
                <div className="text-center mb-5">
                    <div className="inline-flex items-center gap-2 bg-green-500/10 border border-green-500/20 rounded-full px-3 py-1 mb-3">
                        <Calendar className="w-3.5 h-3.5 text-green-400" />
                        <span className="text-xs font-semibold text-green-400 uppercase tracking-wider">{t('greenlight.selection')}</span>
                    </div>
                    <h3 className="text-xl font-bold text-white mb-1">{t('greenlight.whichSeason')}</h3>
                    <p className="text-sm text-white/50 truncate max-w-xs mx-auto">{contentTitle}</p>
                </div>

                {/* Season Grid - Pure CSS hover */}
                <div className="grid grid-cols-5 gap-2 mb-5">
                    {seasons.map((season) => (
                        <button
                            key={season}
                            onClick={() => handleSeasonClick(season)}
                            className="aspect-square rounded-lg bg-white/5 hover:bg-green-500 hover:text-black font-bold text-white border border-white/10 text-base transition-colors duration-100"
                        >
                            {season}
                        </button>
                    ))}
                </div>

                {/* Cancel Button */}
                <button
                    onClick={handleClose}
                    className="w-full py-3 text-white/50 hover:text-white hover:bg-white/5 rounded-lg transition-colors duration-100 text-sm font-medium"
                >
                    {t('greenlight.cancelAction')}
                </button>
            </div>
        </div>
    );

    return createPortal(modalContent, getOverlayPortalRoot());
});

SeasonSelectorModal.displayName = 'SeasonSelectorModal';

// ========================================
// Main Component
// ========================================

const slideVariants = {
    enter: (direction: 'right' | 'left') => ({
        x: direction === 'right' ? 50 : -50,
        opacity: 0,
        scale: 0.95
    }),
    center: {
        zIndex: 1,
        x: 0,
        opacity: 1,
        scale: 1
    },
    exit: (direction: 'right' | 'left') => ({
        zIndex: 0,
        x: direction === 'right' ? -50 : 50,
        opacity: 0,
        scale: 0.95,
        filter: 'blur(10px)'
    })
};

const WishboardNewRequest: React.FC = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const topRef = useRef<HTMLDivElement>(null);
    const [step, setStep] = useState<Step>(1);
    const [direction, setDirection] = useState<'right' | 'left'>('right');

    const navigateStep = (newStep: Step) => {
        setDirection(newStep > step ? 'right' : 'left');
        setStep(newStep);
    };

    const handleBack = () => {
        if (step === 2) {
            // Returning to concept selection: Reset everything
            setContentType(null);
            setStep(1);
        } else {
            setStep((prev) => (prev - 1) as Step);
        }
    };

    // Scroll to top on step change with slight delay to handle layout shifts
    useEffect(() => {
        const timeout = setTimeout(() => {
            topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            // Also scroll window to absolute top
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }, 100);
        return () => clearTimeout(timeout);
    }, [step]);
    const [contentType, setContentType] = useState<ContentType | null>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<TmdbResult[]>([]);
    const [selectedContent, setSelectedContent] = useState<TmdbResult | null>(null);
    const [selectedSeasons, setSelectedSeasons] = useState<number[]>([]);
    const [seasons, setSeasons] = useState<number[]>([]);
    const [loading, setLoading] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const API_URL = import.meta.env.VITE_MAIN_API || '';
    const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';

    const [limitStatus, setLimitStatus] = useState<{ count: number; limit: number; remaining: number; isVip: boolean } | null>(null);

    // Fetch limits
    useEffect(() => {
        const fetchLimits = async () => {
            try {
                const authToken = localStorage.getItem('auth_token');
                const profileId = localStorage.getItem('selected_profile_id');
                const response = await fetch(`${API_URL}/api/wishboard/limits`, {
                    headers: {
                        'Authorization': `Bearer ${authToken}`,
                        'X-Profile-ID': profileId || '',
                        ...getVipHeaders(),
                    }
                });
                if (response.ok) {
                    const data = await response.json();
                    setLimitStatus(data);
                }
            } catch (err) {
                console.error('Error fetching limits:', err);
            }
        };
        fetchLimits();
    }, [API_URL]);

    const searchTmdb = useCallback(async () => {
        if (!searchQuery.trim() || !contentType) return;

        setLoading(true);
        setError(null);

        try {
            const mediaType = contentType === 'season' ? 'tv' : contentType;
            const response = await fetch(
                `https://api.themoviedb.org/3/search/${mediaType}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(searchQuery)}&language=${getTmdbLanguage()}`
            );

            if (response.ok) {
                const data = await response.json();
                setSearchResults(data.results.slice(0, 10).map((r: TmdbResult) => ({
                    ...r,
                    media_type: mediaType,
                })));
            }
        } catch (err) {
            setError(t('greenlight.searchError'));
        } finally {
            setLoading(false);
        }
    }, [searchQuery, contentType, TMDB_API_KEY]);

    // Live search with debounce
    useEffect(() => {
        const timer = setTimeout(() => {
            if (searchQuery.trim()) {
                searchTmdb();
            } else {
                setSearchResults([]);
            }
        }, 500);

        return () => clearTimeout(timer);
    }, [searchQuery, searchTmdb]);

    // Fetch TV show seasons
    const fetchSeasons = async (tvId: number) => {
        try {
            const response = await fetch(
                `https://api.themoviedb.org/3/tv/${tvId}?api_key=${TMDB_API_KEY}&language=${getTmdbLanguage()}`
            );
            if (response.ok) {
                const data = await response.json();
                setSeasons(Array.from({ length: data.number_of_seasons }, (_, i) => i + 1));
            }
        } catch (err) {
            console.error('Error fetching seasons:', err);
        }
    };

    // Handle content selection
    const handleSelectContent = async (content: TmdbResult) => {
        setSelectedContent(content);
        // Set the title in search bar and clear results
        setSearchQuery(getTitle(content));
        setSearchResults([]);

        if (contentType === 'season') {
            await fetchSeasons(content.id);
        }
        // User must click "Continuer" to proceed to step 3
    };

    // Handle season selection (toggle)
    const handleSelectSeason = (season: number) => {
        if (season === 0) {
            // "All seasons" toggle - if already selected, unselect it
            setSelectedSeasons(prev => {
                if (prev.includes(0)) {
                    return []; // Uncheck "all seasons"
                }
                return [0]; // Check "all seasons", clear individual
            });
        } else {
            setSelectedSeasons(prev => {
                // Remove "all seasons" if it was selected
                const withoutAll = prev.filter(s => s !== 0);
                if (withoutAll.includes(season)) {
                    return withoutAll.filter(s => s !== season); // Uncheck this season
                } else {
                    return [...withoutAll, season]; // Check this season
                }
            });
        }
    };

    // Submit request
    const handleSubmit = async () => {
        if (!selectedContent) return;

        setSubmitting(true);
        setError(null);

        try {
            const authToken = localStorage.getItem('auth_token');
            const profileId = localStorage.getItem('selected_profile_id');

            const response = await fetch(`${API_URL}/api/wishboard`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${authToken}`,
                    'X-Profile-ID': profileId || '',
                    ...getVipHeaders(),
                },
                body: JSON.stringify({
                    tmdb_id: selectedContent.id,
                    media_type: contentType === 'season' ? 'tv' : contentType,
                    season_numbers: contentType === 'season' ? selectedSeasons : null,
                }),
            });

            if (response.ok) {
                navigate('/wishboard');
            } else {
                const data = await response.json();
                if (response.status === 429) {
                    setError(data.error || t('greenlight.limitReached'));
                } else {
                    setError(data.error || data.message || t('greenlight.requestCreationError'));
                }
            }
        } catch (err) {
            setError(t('greenlight.requestCreationError'));
        } finally {
            setSubmitting(false);
        }
    };

    // Reset on content type change
    useEffect(() => {
        setSearchResults([]);
        setSelectedContent(null);
        setSelectedSeasons([]);
        setSeasons([]);
        setSearchQuery('');
    }, [contentType]);

    const getTitle = (content: TmdbResult) => content.title || content.name || t('greenlight.untitled');
    const getYear = (content: TmdbResult) =>
        (content.release_date || content.first_air_date)?.split('-')[0] || '';



    return (
        <>
            {/* Invisible scroll anchor at absolute top */}
            <div ref={topRef} className="absolute top-0 left-0 h-0 w-0" aria-hidden="true" />
            <SquareBackground squareSize={48} borderColor="rgba(34, 197, 94, 0.10)" className="min-h-screen bg-black text-white selection:bg-green-500/30">

                {/* Navbar - Using same grid as content to align step indicator with recap */}
                <div className="relative w-full z-40 px-6 md:px-10 pt-24 pb-4 pointer-events-none">
                    <div className="container mx-auto">
                        <div className="grid grid-cols-1 lg:grid-cols-12 lg:gap-12 items-center">
                            {/* Left side - Back button */}
                            <div className="lg:col-span-7 xl:col-span-8 flex items-center justify-between lg:justify-start">
                                {step === 1 ? (
                                    <Link
                                        to="/wishboard"
                                        className="inline-flex items-center gap-2 text-sm text-white/50 hover:text-white transition-colors pointer-events-auto"
                                    >
                                        <ArrowLeft className="h-4 w-4" />
                                        <span>{t('common.back')}</span>
                                    </Link>
                                ) : (
                                    <button
                                        onClick={handleBack}
                                        className="inline-flex items-center gap-2 text-sm text-white/50 hover:text-white transition-colors pointer-events-auto"
                                    >
                                        <ArrowLeft className="h-4 w-4" />
                                        <span>{t('greenlight.backToStep', { step: step - 1 })}</span>
                                    </button>
                                )}

                                {/* Credits - Show on mobile/tablet next to back button */}
                                {limitStatus && (
                                    <div className="lg:hidden flex items-center gap-2 text-xs font-medium text-green-400 bg-green-500/10 px-3 py-1.5 rounded-full border border-green-500/20 pointer-events-auto">
                                        <Zap className="h-3 w-3" />
                                        {limitStatus.remaining} {t('greenlight.credits')}
                                    </div>
                                )}
                            </div>

                            <div className="hidden lg:flex lg:col-span-5 xl:col-span-4 items-center justify-end">
                                {/* Credits - Show on desktop */}
                                {limitStatus && (
                                    <div className="flex items-center gap-2 text-xs font-medium text-green-400 bg-green-500/10 px-3 py-1.5 rounded-full border border-green-500/20 pointer-events-auto">
                                        <Zap className="h-3 w-3" />
                                        {limitStatus.remaining} {t('greenlight.credits')}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Main Content */}
                <div className="relative z-10 container mx-auto px-6 md:px-10 py-6 pb-24 lg:py-8 lg:pb-12">
                    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:gap-12">
                        {/* Left Content */}
                        <div className="lg:col-span-7 xl:col-span-8 flex flex-col items-center justify-start">

                            <AnimatePresence mode="wait">
                                {/* Step 1: Concept Selection */}
                                {step === 1 && (
                                    <motion.div
                                        key="step1"
                                        custom={direction}
                                        variants={slideVariants}
                                        initial="enter"
                                        animate="center"
                                        exit="exit"
                                        transition={{
                                            x: { type: "spring", stiffness: 300, damping: 30 },
                                            opacity: { duration: 0.2 }
                                        }}
                                        className="w-full"
                                    >
                                        <div className="text-center mb-12">
                                            <div className="h-16 mb-2 flex items-center justify-center">
                                                <h1 className="text-4xl md:text-5xl font-black tracking-tight">
                                                    <ShinyText text={t('greenlight.newProject')} speed={3} color="#ffffff" shineColor="#4ade80" className="" />
                                                </h1>
                                            </div>
                                            <div className="h-8 flex items-center justify-center mb-6">
                                                <BlurText
                                                    text={t('greenlight.newProjectQuestion')}
                                                    delay={50}
                                                    className="text-lg text-white/60 max-w-xl mx-auto"
                                                />
                                            </div>

                                            {/* Restored Credit Status */}
                                            {limitStatus && (
                                                <motion.div
                                                    initial={{ opacity: 0, y: 10 }}
                                                    animate={{ opacity: 1, y: 0 }}
                                                    transition={{ delay: 0.5, duration: 0.5 }}
                                                    className="flex flex-col items-center gap-3"
                                                >
                                                    <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium border ${limitStatus.remaining === 0
                                                        ? 'bg-red-500/10 border-red-500/50 text-red-400 shadow-[0_0_20px_-5px_rgba(239,68,68,0.3)]'
                                                        : 'bg-green-500/10 border-green-500/50 text-green-400 shadow-[0_0_20px_-5px_rgba(34,197,94,0.3)]'
                                                        }`}>
                                                        <Zap className="w-4 h-4" />
                                                        <span>{t('greenlight.creditsRemaining', { remaining: limitStatus.remaining, limit: limitStatus.limit })}</span>
                                                    </div>
                                                    {limitStatus.remaining === 0 && !limitStatus.isVip && (
                                                        <Link to="/vip" className="text-sm text-yellow-400 hover:text-yellow-300 underline underline-offset-4 decoration-yellow-500/30 font-medium transition-colors">
                                                            {t('greenlight.upgradeVipCredits')}
                                                        </Link>
                                                    )}
                                                </motion.div>
                                            )}
                                        </div>

                                        <div className="mb-12 flex flex-col items-center gap-6 max-w-2xl mx-auto">
                                            {/* Rule Box */}
                                            <AnimatedBorderCard
                                                highlightColor="34 197 94"
                                                backgroundColor="10 10 10"
                                                animationSpeed={0.3}
                                                className="w-full p-6 rounded-2xl text-center"
                                            >
                                                <div className="inline-flex items-center gap-2 text-green-400 mb-2">
                                                    <AlertCircle className="w-5 h-5" />
                                                    <span className="font-bold uppercase tracking-wider text-xs">{t('greenlight.greenlightRule')}</span>
                                                </div>
                                                <p className="text-sm text-green-100/80 leading-relaxed"
                                                    dangerouslySetInnerHTML={{ __html: t('greenlight.greenlightRuleDesc') }}
                                                />
                                            </AnimatedBorderCard>

                                            {/* VIP Banner */}
                                            <AnimatedBorderCard
                                                highlightColor="251 191 36"
                                                backgroundColor="20 15 5"
                                                animationSpeed={0.3}
                                                className="w-full p-4 rounded-xl flex items-center justify-center gap-4 group"
                                            >
                                                <div className="rounded-full bg-amber-500/20 p-2 group-hover:scale-110 transition-transform">
                                                    <Zap className="h-5 w-5 text-amber-500" />
                                                </div>
                                                <div className="text-left">
                                                    <p className="font-medium text-white text-sm">{t('greenlight.vipPriorityRequests')}</p>
                                                    <p className="text-xs text-amber-100/70" dangerouslySetInnerHTML={{ __html: t('greenlight.vipPriorityRequestsDesc') }} />
                                                </div>
                                            </AnimatedBorderCard>
                                        </div>

                                        {/* Mobile Step Indicator - Step 1 Position */}
                                        <div className="lg:hidden w-full flex justify-center mb-8">
                                            <div className="flex items-center gap-2 bg-white/5 backdrop-blur-md px-4 py-2 rounded-full border border-white/10 shadow-lg">
                                                {[1, 2, 3].map((s) => (
                                                    <React.Fragment key={s}>
                                                        <div className={`flex items-center gap-2 ${step === s ? 'text-white' : 'text-white/30'}`}>
                                                            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-all duration-300 ${step >= s ? 'bg-green-500 text-black' : 'bg-white/10 text-white/50'}`}>
                                                                {step > s ? <Check className="h-3 w-3" /> : s}
                                                            </div>
                                                            <span className={`text-xs font-medium uppercase tracking-wider ${step === s ? 'text-white' : 'text-white/50'}`}>{s === 1 ? t('greenlight.conceptStep') : s === 2 ? t('greenlight.choiceStep') : t('greenlight.validationStep')}</span>
                                                        </div>
                                                        {s < 3 && <div className="relative w-4 h-0.5 bg-white/10 rounded-full mx-1"><div className="h-full bg-green-500" style={{ width: step > s ? "100%" : "0%" }} /></div>}
                                                    </React.Fragment>
                                                ))}
                                            </div>
                                        </div>

                                        <div className="grid md:grid-cols-3 gap-6">
                                            {[
                                                { type: 'movie' as ContentType, icon: Film, title: t('greenlight.movieType'), desc: t('greenlight.movieTypeDesc') },
                                                { type: 'tv' as ContentType, icon: Tv, title: t('greenlight.seriesType'), desc: t('greenlight.seriesTypeDesc') },
                                                { type: 'season' as ContentType, icon: Calendar, title: t('greenlight.seasonType'), desc: t('greenlight.seasonTypeDesc') },
                                            ].map((option) => {
                                                const isSelected = contentType === option.type;
                                                return (
                                                    <motion.button
                                                        key={option.type}
                                                        whileHover={{ y: -5 }}
                                                        whileTap={{ scale: 0.98 }}
                                                        onClick={() => {
                                                            // Always reset form when starting a new selection, even if same type
                                                            setSearchResults([]);
                                                            setSelectedContent(null);
                                                            setSelectedSeasons([]);
                                                            setSeasons([]);
                                                            setSearchQuery('');

                                                            // Only select the type, user must click "Continuer" in recap to proceed
                                                            setContentType(option.type);
                                                        }}
                                                        className="group relative h-full w-full"
                                                    >
                                                        <AnimatedBorderCard
                                                            highlightColor="34 197 94"
                                                            backgroundColor="10 10 10"
                                                            className={`h-full w-full p-8 flex flex-col items-center rounded-3xl transition-all duration-300 ${isSelected
                                                                ? 'ring-2 ring-green-500 shadow-[0_0_30px_rgba(34,197,94,0.2)] bg-green-500/10'
                                                                : 'border border-white/5 hover:ring-1 hover:ring-green-500/50 hover:bg-white/5'
                                                                }`}
                                                        >
                                                            <div className={`w-20 h-20 rounded-2xl flex items-center justify-center mb-6 transition-transform shadow-lg ${isSelected
                                                                ? 'bg-green-500 text-black scale-110 shadow-green-500/20'
                                                                : 'bg-gradient-to-br from-white/5 to-white/0 text-white group-hover:scale-110 group-hover:text-green-400'
                                                                }`}>
                                                                <option.icon className={`h-10 w-10 transition-colors ${isSelected ? 'text-black' : ''}`} />
                                                            </div>
                                                            <ShinyText
                                                                text={option.title}
                                                                speed={3}
                                                                color={isSelected ? "#4ade80" : "#ffffff"}
                                                                shineColor={isSelected ? "#ffffff" : "#22c55e"}
                                                                className="text-xl font-bold mb-2 block"
                                                            />
                                                            <p className={`text-sm transition-colors ${isSelected ? 'text-white/80' : 'text-white/40'}`}>{option.desc}</p>
                                                        </AnimatedBorderCard>
                                                    </motion.button>
                                                );
                                            })}
                                        </div>
                                    </motion.div>
                                )}

                                {/* Step 2: Search Interface */}
                                {step === 2 && (
                                    <motion.div
                                        key="step2"
                                        custom={direction}
                                        variants={slideVariants}
                                        initial="enter"
                                        animate="center"
                                        exit="exit"
                                        transition={{
                                            x: { type: "spring", stiffness: 300, damping: 30 },
                                            opacity: { duration: 0.2 }
                                        }}
                                        className="w-full max-w-2xl"
                                    >
                                        <div className="text-center mb-8">
                                            <h2 className="text-3xl font-bold text-white mb-2">
                                                {contentType === 'movie' ? t('greenlight.whichMovie') : contentType === 'tv' ? t('greenlight.whichSeries') : t('greenlight.whichSeriesAndSeason')}
                                            </h2>
                                            <p className="text-white/50">
                                                {t('greenlight.searchTmdbHint')}
                                            </p>
                                        </div>

                                        {/* Mobile Step Indicator - Step 2 Position */}
                                        <div className="lg:hidden w-full flex justify-center mb-8">
                                            <div className="flex items-center gap-2 bg-white/5 backdrop-blur-md px-4 py-2 rounded-full border border-white/10 shadow-lg">
                                                {[1, 2, 3].map((s) => (
                                                    <React.Fragment key={s}>
                                                        <div className={`flex items-center gap-2 ${step === s ? 'text-white' : 'text-white/30'}`}>
                                                            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-all duration-300 ${step >= s ? 'bg-green-500 text-black' : 'bg-white/10 text-white/50'}`}>
                                                                {step > s ? <Check className="h-3 w-3" /> : s}
                                                            </div>
                                                            <span className={`text-xs font-medium uppercase tracking-wider ${step === s ? 'text-white' : 'text-white/50'}`}>{s === 1 ? t('greenlight.conceptStep') : s === 2 ? t('greenlight.choiceStep') : t('greenlight.validationStep')}</span>
                                                        </div>
                                                        {s < 3 && <div className="relative w-4 h-0.5 bg-white/10 rounded-full mx-1"><div className="h-full bg-green-500" style={{ width: step > s ? "100%" : "0%" }} /></div>}
                                                    </React.Fragment>
                                                ))}
                                            </div>
                                        </div>

                                        {/* Search Input */}
                                        <div className="mb-6">
                                            <label className="text-sm text-white/60 mb-2 block">
                                                {contentType === 'movie' ? t('greenlight.searchMovie') : t('greenlight.searchSeries')}
                                            </label>
                                            <div className={`relative flex items-center bg-black/50 border rounded-xl p-2 transition-colors ${selectedContent ? 'border-green-500/50' : 'border-white/10 focus-within:border-green-500/50'
                                                }`}>
                                                <Search className="ml-3 h-5 w-5 text-white opacity-30" />
                                                <input
                                                    type="text"
                                                    value={searchQuery}
                                                    onChange={(e) => {
                                                        setSearchQuery(e.target.value);
                                                        // If user clears or modifies the title, reset selection
                                                        if (selectedContent && e.target.value !== getTitle(selectedContent)) {
                                                            setSelectedContent(null);
                                                            setSelectedSeasons([]);
                                                            setSeasons([]);
                                                        }
                                                    }}
                                                    onKeyDown={(e) => e.key === 'Enter' && searchTmdb()}
                                                    placeholder={t('greenlight.typeTitlePlaceholder')}
                                                    className="w-full bg-transparent border-none text-base p-3 text-white placeholder:text-white/40 focus:outline-none focus:ring-0"
                                                    autoFocus={!selectedContent}
                                                />
                                                {loading && <Loader2 className="mr-3 h-5 w-5 animate-spin text-green-500" />}
                                                {selectedContent && (
                                                    <div className="mr-3 flex items-center gap-1 text-green-400">
                                                        <Check className="h-4 w-4" />
                                                    </div>
                                                )}
                                            </div>
                                        </div>

                                        {/* Search Results - show only when searching and no content selected */}
                                        {searchResults.length > 0 && !selectedContent && (
                                            <div className="space-y-3 mb-8">
                                                <AnimatePresence>
                                                    {searchResults.map((result, i) => (
                                                        <motion.div
                                                            key={result.id}
                                                            initial={{ opacity: 0, x: -20 }}
                                                            animate={{ opacity: 1, x: 0 }}
                                                            transition={{ delay: i * 0.05 }}
                                                            onClick={() => handleSelectContent(result)}
                                                            className="relative flex w-full items-center gap-4 p-4 text-left transition-all rounded-xl cursor-pointer group bg-white/5 border border-white/5 hover:bg-white/10 hover:border-white/20"
                                                        >
                                                            <div className="relative h-20 w-14 flex-shrink-0 overflow-hidden rounded-lg bg-white/10">
                                                                {result.poster_path ? (
                                                                    <img src={`https://image.tmdb.org/t/p/w92${result.poster_path}`} alt={getTitle(result)} className="h-full w-full object-cover" />
                                                                ) : (
                                                                    <div className="flex h-full w-full items-center justify-center"><Film className="h-6 w-6 text-white opacity-20" /></div>
                                                                )}
                                                            </div>
                                                            <div className="flex-1 min-w-0">
                                                                <p className="truncate text-base font-bold text-white group-hover:text-green-400 transition-colors">
                                                                    {getTitle(result)}<span className="ml-2 font-medium text-white/40 text-sm">({getYear(result)})</span>
                                                                </p>
                                                                <p className="mt-1 line-clamp-2 text-xs text-white/50 leading-relaxed">{result.overview || t('greenlight.noDescription')}</p>
                                                            </div>
                                                            <div className="hidden sm:block flex-shrink-0 rounded bg-white/10 px-2.5 py-1 text-xs font-medium text-white/60 border border-white/5">
                                                                {result.media_type === 'movie' ? t('greenlight.movieType') : t('greenlight.seriesType')}
                                                            </div>
                                                        </motion.div>
                                                    ))}
                                                </AnimatePresence>
                                            </div>
                                        )}

                                        {/* Inline Season Selection - show when content is selected and type is season */}
                                        {contentType === 'season' && selectedContent && seasons.length > 0 && (
                                            <motion.div
                                                initial={{ opacity: 0, y: 10 }}
                                                animate={{ opacity: 1, y: 0 }}
                                                className="mt-6"
                                            >
                                                {/* Selected Series Display */}
                                                <div className="flex items-center gap-4 p-4 bg-white/5 border border-white/10 rounded-xl mb-6">
                                                    <div className="w-14 h-20 rounded-lg overflow-hidden bg-white/10 flex-shrink-0">
                                                        {selectedContent.poster_path ? (
                                                            <img src={`https://image.tmdb.org/t/p/w92${selectedContent.poster_path}`} alt="" className="w-full h-full object-cover" />
                                                        ) : (
                                                            <div className="w-full h-full flex items-center justify-center"><Film className="w-5 h-5 text-white opacity-20" /></div>
                                                        )}
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <p className="font-bold text-white truncate">{getTitle(selectedContent)}</p>
                                                        <p className="text-sm text-white/50">{getYear(selectedContent)} • {seasons.length} {t('greenlight.seasonLabel').toLowerCase()}s</p>
                                                    </div>
                                                    <button
                                                        onClick={() => {
                                                            setSelectedContent(null);
                                                            setSelectedSeasons([]);
                                                            setSeasons([]);
                                                            setSearchQuery('');
                                                        }}
                                                        className="px-4 py-2 text-sm font-medium text-white/60 hover:text-white bg-white/5 hover:bg-white/10 rounded-lg border border-white/10 transition-colors"
                                                    >
                                                        {t('greenlight.change')}
                                                    </button>
                                                </div>

                                                <label className="text-sm text-white/60 mb-3 block">{t('greenlight.whichSeasons')}</label>

                                                {/* All Seasons Option */}
                                                <div
                                                    onClick={() => handleSelectSeason(0)}
                                                    className={`mb-4 p-4 rounded-xl border cursor-pointer transition-all ${selectedSeasons.includes(0) ? 'bg-red-500/20 border-red-500/50' : 'bg-white/5 border-white/10 hover:border-white/20'}`}
                                                >
                                                    <div className="flex items-center gap-3">
                                                        <div className={`w-5 h-5 rounded border-2 flex items-center justify-center ${selectedSeasons.includes(0) ? 'bg-red-500 border-red-500' : 'border-white/30'}`}>
                                                            {selectedSeasons.includes(0) && <Check className="w-3 h-3 text-white" />}
                                                        </div>
                                                        <div>
                                                            <p className="font-semibold text-white">{t('greenlight.allSeasons')}</p>
                                                            <p className="text-xs text-white/50">{t('greenlight.seasonsAvailable', { count: seasons.length })}</p>
                                                        </div>
                                                    </div>
                                                </div>

                                                <div className="relative flex items-center my-4">
                                                    <div className="flex-1 h-px bg-white/10"></div>
                                                    <span className="px-4 text-xs text-white/40">{t('greenlight.orSelectSeasons')}</span>
                                                    <div className="flex-1 h-px bg-white/10"></div>
                                                </div>

                                                {/* Individual Season Cards */}
                                                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
                                                    {seasons.map((season) => (
                                                        <div
                                                            key={season}
                                                            onClick={() => handleSelectSeason(season)}
                                                            className={`p-4 rounded-xl border cursor-pointer transition-all text-center ${selectedSeasons.includes(season) ? 'bg-red-500/20 border-red-500/50' : 'bg-white/5 border-white/10 hover:border-white/20 hover:bg-white/10'}`}
                                                        >
                                                            <div className={`w-5 h-5 mx-auto mb-2 rounded border-2 flex items-center justify-center ${selectedSeasons.includes(season) ? 'bg-red-500 border-red-500' : 'border-white/30'}`}>
                                                                {selectedSeasons.includes(season) && <Check className="w-3 h-3 text-white" />}
                                                            </div>
                                                            <p className="font-semibold text-white text-sm">{t('greenlight.seasonNum', { num: season })}</p>
                                                            <p className="text-xs text-white/40">{t('greenlight.episodesCount')}</p>
                                                        </div>
                                                    ))}
                                                </div>
                                            </motion.div>
                                        )}
                                    </motion.div>
                                )}

                                {/* Step 3: Final Confirmation */}
                                {step === 3 && selectedContent && (
                                    <motion.div
                                        key="step3"
                                        custom={direction}
                                        variants={slideVariants}
                                        initial="enter"
                                        animate="center"
                                        exit="exit"
                                        transition={{
                                            x: { type: "spring", stiffness: 300, damping: 30 },
                                            opacity: { duration: 0.2 }
                                        }}
                                        className="w-full"
                                    >
                                        <div className="w-full">
                                            {/* Mobile Step Indicator - Embedded in Step 3 */}
                                            <div className="mb-6 lg:hidden">
                                                <div className="w-full">
                                                    <div className="relative flex items-center justify-center">
                                                        <div className="flex items-center gap-2 bg-white/5 backdrop-blur-md px-4 py-2 rounded-full border border-white/10 shadow-lg">
                                                            {[1, 2, 3].map((s) => (
                                                                <React.Fragment key={s}>
                                                                    <div className={`flex items-center gap-2 ${step === s ? 'text-white' : 'text-white/30'}`}>
                                                                        <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-all duration-300 ${step >= s ? 'bg-green-500 text-black' : 'bg-white/10 text-white/50'}`}>
                                                                            {step > s ? <Check className="h-3 w-3" /> : s}
                                                                        </div>
                                                                        <span className={`text-xs font-medium uppercase tracking-wider ${step === s ? 'text-white' : 'text-white/50'}`}>
                                                                            {s === 1 ? t('greenlight.conceptStep') : s === 2 ? t('greenlight.choiceStep') : t('greenlight.validationStep')}
                                                                        </span>
                                                                    </div>
                                                                    {s < 3 && (
                                                                        <div className="relative w-4 h-0.5 bg-white/10 rounded-full mx-1">
                                                                            <div className="h-full bg-green-500" style={{ width: step > s ? "100%" : "0%" }} />
                                                                        </div>
                                                                    )}
                                                                </React.Fragment>
                                                            ))}
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="space-y-6">
                                                <div>
                                                    <h2 className="text-2xl font-bold text-white">{t('greenlight.confirmation')}</h2>
                                                    <p className="text-white/60">{t('greenlight.lastStepBeforeValidation')}</p>
                                                </div>

                                                <div className="rounded-lg bg-white/5 overflow-hidden border border-white/10">
                                                    <div className="relative h-32 overflow-hidden">
                                                        {selectedContent.backdrop_path || selectedContent.poster_path ? (
                                                            <img
                                                                src={`https://image.tmdb.org/t/p/w780${selectedContent.backdrop_path || selectedContent.poster_path}`}
                                                                alt=""
                                                                className="h-full w-full object-cover"
                                                            />
                                                        ) : (
                                                            <div className="h-full w-full bg-white/10" />
                                                        )}
                                                        <div className="absolute inset-0 bg-gradient-to-t from-black to-transparent"></div>
                                                        <div className="absolute inset-0 bg-gradient-to-t from-white/10 to-transparent"></div>
                                                    </div>
                                                    <div className="p-6 pt-0 -mt-12 relative">
                                                        <div className="flex gap-4">
                                                            <img
                                                                src={`https://image.tmdb.org/t/p/w342${selectedContent.poster_path}`}
                                                                alt={getTitle(selectedContent)}
                                                                className="h-36 w-24 flex-shrink-0 rounded-lg object-cover shadow-lg border border-white/10"
                                                            />
                                                            <div className="flex-1 pt-2">
                                                                <span className="whitespace-nowrap inline-flex items-center text-[10px] uppercase font-bold tracking-wider bg-white/10 text-white/90 rounded-md px-2 py-1 mb-2 border border-white/10">
                                                                    {contentType === 'movie' ? <Film className="h-3 w-3 mr-1" /> : <Tv className="h-3 w-3 mr-1" />}
                                                                    {contentType === 'movie' ? t('greenlight.movieType') : t('greenlight.seriesType')}
                                                                </span>
                                                                <h3 className="text-xl font-bold text-white leading-tight mb-1">{getTitle(selectedContent)}</h3>
                                                                <p className="text-sm text-green-400 font-medium">
                                                                    {getYear(selectedContent)}
                                                                    {selectedSeasons.length > 0 && (
                                                                        <span className="ml-2">
                                                                            • {selectedSeasons.includes(0) ? t('greenlight.integral') : selectedSeasons.sort((a, b) => a - b).map(s => `S${s}`).join(', ')}
                                                                        </span>
                                                                    )}
                                                                </p>
                                                                <p className="mt-2 line-clamp-3 text-sm text-white/50 leading-relaxed">
                                                                    {selectedContent.overview || t('greenlight.noDescription')}
                                                                </p>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>

                                                {error && (
                                                    <div className="text-red-400 text-sm bg-red-500/10 p-4 rounded-lg border border-red-500/20 flex items-center gap-3">
                                                        <AlertCircle className="h-5 w-5 shrink-0" />
                                                        {error}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>

                        {/* Right Sidebar - Récapitulatif */}
                        <div className="col-span-1 lg:col-span-5 xl:col-span-4 mt-8 lg:mt-0">
                            <div className="lg:sticky lg:top-24">
                                {/* Step Indicator */}
                                <div className="hidden lg:flex items-center justify-center mb-6">
                                    <div className="flex items-center gap-2 bg-white/5 backdrop-blur-md px-4 py-2 rounded-full border border-white/10 pointer-events-auto shadow-lg">
                                        {[1, 2, 3].map((s) => (
                                            <React.Fragment key={s}>
                                                <div
                                                    className={`flex items-center gap-2 ${step === s ? 'text-white' : 'text-white/30'} transition-colors duration-300`}
                                                    style={{ transitionDelay: step === s && step > 1 ? '0.6s' : '0s' }}
                                                >
                                                    <motion.div
                                                        animate={{
                                                            backgroundColor: step >= s ? '#22c55e' : 'rgba(255,255,255,0.1)',
                                                            color: step >= s ? '#000000' : 'rgba(255,255,255,0.5)',
                                                            boxShadow: step >= s ? '0 0 15px rgba(34,197,94,0.5)' : 'none',
                                                            scale: step === s ? 1.1 : 1
                                                        }}
                                                        transition={{
                                                            duration: 0.3,
                                                            delay: step === s && step > 1 ? 0.6 : 0
                                                        }}
                                                        className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold"
                                                    >
                                                        {step > s ? <Check className="h-3 w-3" /> : s}
                                                    </motion.div>
                                                    <span className="text-xs font-medium uppercase tracking-wider">
                                                        {s === 1 ? t('greenlight.conceptStep') : s === 2 ? t('greenlight.choiceStep') : t('greenlight.validationStepFull')}
                                                    </span>
                                                </div>
                                                {s < 3 && (
                                                    <div className="relative w-8 h-0.5 bg-white/10 rounded-full overflow-hidden mx-1">
                                                        <motion.div
                                                            className="h-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.8)]"
                                                            initial={false}
                                                            animate={{ width: step > s ? "100%" : "0%" }}
                                                            transition={{ duration: 0.6, ease: "easeInOut" }}
                                                        />
                                                    </div>
                                                )}
                                            </React.Fragment>
                                        ))}
                                    </div>
                                </div>
                                <motion.div
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    className="rounded-lg bg-white/5 border border-white/10"
                                >
                                    <div className="p-6 pb-4 border-b border-white/10">
                                        <h3 className="text-lg font-semibold text-white">{t('greenlight.summary')}</h3>
                                    </div>
                                    <div className="p-6 space-y-4">
                                        {/* Content Type */}
                                        <div className="flex items-center gap-3">
                                            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-500/10">
                                                {contentType === 'movie' ? (
                                                    <Film className="h-5 w-5 text-white" />
                                                ) : contentType ? (
                                                    <Tv className="h-5 w-5 text-white" />
                                                ) : (
                                                    <Film className="h-5 w-5 text-white opacity-30" />
                                                )}
                                            </div>
                                            <div>
                                                <p className="text-xs text-white/50">{t('greenlight.contentType')}</p>
                                                <p className="font-medium text-white">
                                                    {contentType === 'movie' ? t('greenlight.movieType')
                                                        : contentType === 'tv' ? t('greenlight.seriesType')
                                                            : contentType === 'season' ? t('greenlight.specificSeason')
                                                                : t('greenlight.notSelected')}
                                                </p>
                                            </div>
                                        </div>

                                        {/* Selected Content */}
                                        {selectedContent ? (
                                            <div className="flex items-center gap-3">
                                                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-500/10 overflow-hidden shrink-0">
                                                    {selectedContent.poster_path ? (
                                                        <img
                                                            src={`https://image.tmdb.org/t/p/w92${selectedContent.poster_path}`}
                                                            alt=""
                                                            className="w-full h-full object-cover"
                                                        />
                                                    ) : (
                                                        <Film className="h-5 w-5 text-white" />
                                                    )}
                                                </div>
                                                <div className="min-w-0">
                                                    <p className="text-xs text-white/50">{t('greenlight.selectedContent')}</p>
                                                    <p className="font-medium text-white truncate">{getTitle(selectedContent)}</p>
                                                </div>
                                            </div>
                                        ) : (
                                            <p className="py-2 text-sm text-white/30 italic">
                                                {step === 1
                                                    ? (contentType ? t('greenlight.typeSelected') : t('greenlight.selectAType'))
                                                    : t('greenlight.waitingForSelection')}
                                            </p>
                                        )}

                                        {/* Selected Seasons */}
                                        {(selectedSeasons.length > 0 || (contentType === 'season' && selectedContent)) && (
                                            <div className="flex items-center gap-3">
                                                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-500/10">
                                                    <Calendar className="h-5 w-5 text-white" />
                                                </div>
                                                <div>
                                                    <p className="text-xs text-white/50">{t('greenlight.seasonLabel')}</p>
                                                    <p className="font-medium text-white">
                                                        {selectedSeasons.length > 0
                                                            ? (selectedSeasons.includes(0) ? t('greenlight.allSeasons') : selectedSeasons.sort((a, b) => a - b).map(s => `S${s}`).join(', '))
                                                            : '...'}
                                                    </p>
                                                </div>
                                            </div>
                                        )}

                                        {/* Action Buttons */}
                                        <div className="hidden lg:block pt-4 mt-4 border-t border-white/10 space-y-3">
                                            <Button
                                                onClick={() => {
                                                    if (step === 1 && contentType) {
                                                        navigateStep(2);
                                                    } else if (step === 3) {
                                                        handleSubmit();
                                                    } else if (selectedContent && (contentType !== 'season' || selectedSeasons.length > 0)) {
                                                        navigateStep(3);
                                                    }
                                                }}
                                                disabled={
                                                    (step === 1 && !contentType) ||
                                                    (step === 2 && (!selectedContent || (contentType === 'season' && selectedSeasons.length === 0))) ||
                                                    (step === 3 && submitting)
                                                }
                                                className="w-full h-12 rounded-xl bg-green-600 hover:bg-green-700 text-white font-bold disabled:opacity-30 disabled:cursor-not-allowed"
                                            >
                                                {step === 3 ? (
                                                    submitting ? <Loader2 className="h-5 w-5 animate-spin" /> : t('greenlight.postProject')
                                                ) : (
                                                    <>{t('greenlight.continueButton')} <ArrowRight className="ml-2 h-4 w-4" /></>
                                                )}
                                            </Button>

                                            {step > 1 && (
                                                <button
                                                    onClick={handleBack}
                                                    className="w-full flex items-center justify-center gap-2 py-2 text-sm text-white/70 transition-colors hover:text-white"
                                                >
                                                    <ArrowLeft className="h-4 w-4" />
                                                    {t('greenlight.previousStep')}
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                </motion.div>
                            </div>
                        </div>
                    </div>
                </div>


                {/* Mobile Bottom Bar - Action Button Only */}
                <div className="lg:hidden fixed bottom-0 left-0 right-0 z-50 border-t border-white/10 bg-black/95 p-4 flex flex-col gap-2">
                    <Button
                        onClick={() => {
                            if (step === 1 && contentType) {
                                navigateStep(2);
                            } else if (step === 2 && selectedContent && (contentType !== 'season' || selectedSeasons.length > 0)) {
                                navigateStep(3);
                            } else if (step === 3) {
                                handleSubmit();
                            }
                        }}
                        disabled={
                            (step === 1 && !contentType) ||
                            (step === 2 && (!selectedContent || (contentType === 'season' && selectedSeasons.length === 0))) ||
                            (step === 3 && submitting)
                        }
                        className="w-full h-12 rounded-xl bg-green-600 hover:bg-green-700 text-white font-bold disabled:opacity-30 shadow-lg shadow-green-900/20"
                    >
                        {step === 3 ? (
                            submitting ? <Loader2 className="h-5 w-5 animate-spin" /> : t('greenlight.postProject')
                        ) : (
                            <>{t('greenlight.continueButton')} <ArrowRight className="ml-2 h-4 w-4" /></>
                        )}
                    </Button>

                    {step > 1 && (
                        <button
                            onClick={handleBack}
                            className="flex items-center justify-center gap-2 py-2 text-sm text-white/70 transition-colors hover:text-white"
                        >
                            <ArrowLeft className="h-4 w-4" />
                            {t('greenlight.previousStep')}
                        </button>
                    )}
                </div>

            </SquareBackground>
        </>
    );
};

export default WishboardNewRequest;