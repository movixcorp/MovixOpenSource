import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X, HelpCircle, Users, ChevronLeft, ChevronRight } from 'lucide-react';
import useEmblaCarousel from 'embla-carousel-react';
import { useTranslation } from 'react-i18next';
import { getOverlayPortalRoot } from '../utils/overlayPortal';

interface WatchPartyTutorialModalProps {
    isOpen: boolean;
    onClose: () => void;
}

const WatchPartyTutorialModal: React.FC<WatchPartyTutorialModalProps> = ({ isOpen, onClose }) => {
    const { t } = useTranslation();
    const [currentSlide, setCurrentSlide] = useState(0);
    const [isClosing, setIsClosing] = useState(false);
    const [zoomedImage, setZoomedImage] = useState<string | null>(null);
    const [emblaRef, emblaApi] = useEmblaCarousel({ loop: true });

    // Disable body scroll when modal is open
    useEffect(() => {
        if (!isOpen) return;

        const originalOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';

        return () => {
            document.body.style.overflow = originalOverflow;
        };
    }, [isOpen]);

    const tutorialSlides = [
        {
            image: '/WatchpartyTutorial/1.png',
            text: t('watchParty.tutorialStep1')
        },
        {
            image: '/WatchpartyTutorial/2.png',
            text: t('watchParty.tutorialStep2')
        },
        {
            image: '/WatchpartyTutorial/3.png',
            text: t('watchParty.tutorialStep3')
        },
        {
            title: t('watchParty.advancedFeatures'),
            text: t('watchParty.advancedFeaturesDesc')
        }
    ];

    const scrollPrev = useCallback(() => {
        if (emblaApi) emblaApi.scrollPrev();
    }, [emblaApi]);

    const scrollNext = useCallback(() => {
        if (emblaApi) emblaApi.scrollNext();
    }, [emblaApi]);

    const scrollTo = useCallback((index: number) => {
        if (emblaApi) emblaApi.scrollTo(index);
    }, [emblaApi]);

    const onSelect = useCallback((emblaApi: any) => {
        setCurrentSlide(emblaApi.selectedScrollSnap());
    }, []);

    useEffect(() => {
        if (!emblaApi) return;

        onSelect(emblaApi);
        emblaApi.on('select', onSelect);
        emblaApi.on('reInit', onSelect);

        return () => {
            emblaApi.off('select', onSelect);
            emblaApi.off('reInit', onSelect);
        };
    }, [emblaApi, onSelect]);

    const handleClose = () => {
        setIsClosing(true);
        setTimeout(() => {
            onClose();
            setIsClosing(false);
            setCurrentSlide(0);
            // We can't easily reset embla here without mounting, but state reset helps
        }, 300);
    };

    if (!isOpen) return null;

    const modalContent = (
        <AnimatePresence mode="wait">
            {isOpen && !isClosing && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.3 }}
                    className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-[100000]"
                    onClick={(e) => {
                        if (e.target === e.currentTarget) handleClose();
                    }}
                >
                    <motion.div
                        initial={{ scale: 0.9, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.95, opacity: 0 }}
                        transition={{ duration: 0.3 }}
                        className="bg-gray-900 border border-white/10 rounded-2xl max-w-2xl w-full overflow-hidden shadow-2xl flex flex-col max-h-[85dvh]"
                    >
                        {/* Header */}
                        <div className="p-4 md:p-6 border-b border-white/10 flex justify-between items-center shrink-0">
                            <h3 className="text-lg md:text-xl font-bold text-white flex items-center gap-2">
                                <HelpCircle className="text-red-500 h-5 w-5 md:h-6 md:w-6" />
                                {t('watchParty.howToCreate')}
                            </h3>
                            <motion.button
                                whileHover={{ scale: 1.05 }}
                                whileTap={{ scale: 0.95 }}
                                onClick={handleClose}
                                className="text-white/50 hover:text-white p-2 rounded-lg hover:bg-white/10 transition-colors"
                            >
                                <X className="w-5 h-5 md:w-6 md:h-6" />
                            </motion.button>
                        </div>

                        {/* Content */}
                        <div className="p-4 md:p-6 md:pb-8 flex-1 overflow-y-auto custom-scrollbar overscroll-contain">
                            <div className="relative border border-white/10 rounded-lg overflow-hidden bg-black/50 group shrink-0">
                                {/* Embla Carousel Viewport */}
                                <div className="overflow-hidden" ref={emblaRef}>
                                    <div className="flex touch-pan-y">
                                        {tutorialSlides.map((slide, index) => (
                                            <div className="flex-[0_0_100%] min-w-0" key={index}>
                                                <div className="aspect-video flex items-center justify-center p-1 bg-black/40">
                                                    {slide.image ? (
                                                        <img
                                                            src={slide.image}
                                                            alt={`${t('watchParty.step')} ${index + 1}`}
                                                            className="max-w-full h-full object-contain mx-auto cursor-zoom-in"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                setZoomedImage(slide.image);
                                                            }}
                                                        />
                                                    ) : (
                                                        <div className="px-12 py-4 md:px-16 md:py-8 text-center select-none flex flex-col items-center justify-center h-full">
                                                            <Users className="h-10 w-10 md:h-16 md:w-16 text-red-500 mb-4" />
                                                            <h4 className="text-lg md:text-xl font-bold text-white mb-2">{slide.title}</h4>
                                                            <p className="text-sm md:text-base text-white/70 max-w-md mx-auto leading-relaxed">{slide.text}</p>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                {/* Navigation Buttons */}
                                <button
                                    onClick={scrollPrev}
                                    className="absolute left-2 md:left-4 top-1/2 -translate-y-1/2 p-2 md:p-3 bg-black/50 hover:bg-red-600 rounded-full text-white transition-all backdrop-blur-sm z-10"
                                >
                                    <ChevronLeft size={20} className="md:w-6 md:h-6" />
                                </button>
                                <button
                                    onClick={scrollNext}
                                    className="absolute right-2 md:right-4 top-1/2 -translate-y-1/2 p-2 md:p-3 bg-black/50 hover:bg-red-600 rounded-full text-white transition-all backdrop-blur-sm z-10"
                                >
                                    <ChevronRight size={20} className="md:w-6 md:h-6" />
                                </button>
                            </div>

                            {/* Dynamic Text for current slide */}
                            <motion.div
                                key={`text-${currentSlide}`}
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                className="text-center mt-4 px-2 min-h-[3rem] flex items-center justify-center"
                            >
                                <p className="text-white/90 text-sm md:text-lg font-medium">
                                    {tutorialSlides[currentSlide].text}
                                </p>
                            </motion.div>

                            {/* Pagination Dots */}
                            <div className="flex justify-center gap-2 md:gap-3 mt-4 mb-2">
                                {tutorialSlides.map((_, index) => (
                                    <button
                                        key={index}
                                        onClick={() => scrollTo(index)}
                                        className={`h-1.5 md:h-2 rounded-full transition-all duration-300 ${index === currentSlide ? 'bg-red-500 w-6 md:w-8' : 'bg-white/20 w-1.5 md:w-2 hover:bg-white/40'
                                            }`}
                                    />
                                ))}
                            </div>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );

    const zoomOverlay = (
        <AnimatePresence>
            {zoomedImage && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="fixed inset-0 bg-black/95 z-[100001] flex items-center justify-center p-4 cursor-zoom-out"
                    onClick={() => setZoomedImage(null)}
                >
                    <motion.img
                        initial={{ scale: 0.9 }}
                        animate={{ scale: 1 }}
                        exit={{ scale: 0.9 }}
                        src={zoomedImage}
                        alt="Zoom"
                        className="max-w-full max-h-screen object-contain rounded-lg shadow-2xl"
                    />
                    <button
                        onClick={() => setZoomedImage(null)}
                        className="absolute top-4 right-4 p-2 bg-black/50 hover:bg-white/20 rounded-full text-white transition-colors"
                    >
                        <X className="w-8 h-8" />
                    </button>
                </motion.div>
            )}
        </AnimatePresence>
    );

    return createPortal(
        <>
            {modalContent}
            {zoomOverlay}
        </>,
        getOverlayPortalRoot()
    );
};

export default WatchPartyTutorialModal;
