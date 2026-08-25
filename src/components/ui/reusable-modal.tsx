import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { getOverlayPortalRoot } from '../../utils/overlayPortal';

interface ReusableModalProps {
    isOpen: boolean;
    onClose: () => void;
    title?: string;
    children: React.ReactNode;
    className?: string; // For customized width/height if needed
}

/**
 * Modal réutilisable avec fade + scale in/out via framer-motion.
 *
 * **Pattern AnimatePresence avec `isOpen` direct** (pas de state `isClosing`
 * interne) : quand `isOpen` passe de `true` à `false`, AnimatePresence garde
 * le motion.div monté le temps de jouer l'animation `exit`, puis démonte.
 * Ça marche quel que soit comment `isOpen` devient false :
 *   - click X → `onClose()` → parent set false → exit anime
 *   - click backdrop → idem
 *   - click bouton interne (ex. "Annuler", "Confirmer") → idem
 *   - close programmatique depuis le parent → idem
 *
 * L'ancien pattern `isClosing + setTimeout` ne fonctionnait que sur le
 * chemin "click X" interne ; dès qu'un parent changeait `isOpen` directement
 * (ex. bouton "Annuler" d'un popup de confirmation) le modal unmountait
 * instantanément sans exit — ce qui cassait le fade-out observé par l'user.
 */
const ReusableModal: React.FC<ReusableModalProps> = ({
    isOpen,
    onClose,
    title,
    children,
    className = "max-w-2xl"
}) => {
    // Disable body scroll when modal is open (sync avec isOpen live).
    useEffect(() => {
        if (!isOpen) return;

        const originalOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';

        return () => {
            document.body.style.overflow = originalOverflow;
        };
    }, [isOpen]);

    const modalContent = (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    key="backdrop"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2, ease: 'easeOut' }}
                    data-lenis-prevent
                    className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-[100000]"
                    onClick={(e) => {
                        if (e.target === e.currentTarget) onClose();
                    }}
                >
                    <motion.div
                        key="panel"
                        initial={{ scale: 0.92, opacity: 0, y: 8 }}
                        animate={{ scale: 1, opacity: 1, y: 0 }}
                        exit={{ scale: 0.95, opacity: 0, y: 8 }}
                        transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                        data-lenis-prevent
                        className={`bg-gray-900 border border-white/10 rounded-2xl w-full max-h-[90vh] overflow-hidden flex flex-col shadow-2xl ${className}`}
                    >
                        {/* Header */}
                        <div className="flex justify-between items-center p-6 border-b border-white/10 shrink-0">
                            <h3 className="text-xl font-bold text-white">{title}</h3>
                            <motion.button
                                whileHover={{ scale: 1.05 }}
                                whileTap={{ scale: 0.95 }}
                                onClick={onClose}
                                className="text-gray-400 hover:text-white p-2 rounded-lg hover:bg-white/10 transition-colors"
                            >
                                <X className="w-5 h-5" />
                            </motion.button>
                        </div>

                        {/* Content */}
                        <div className="overflow-y-auto p-6" data-lenis-prevent style={{ overscrollBehavior: 'contain' }}>
                            {children}
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );

    return createPortal(modalContent, getOverlayPortalRoot());
};

export default ReusableModal;
