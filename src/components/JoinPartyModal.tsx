import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Key, ArrowRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getOverlayPortalRoot } from '@/utils/overlayPortal';

interface JoinPartyModalProps {
    isOpen: boolean;
    onClose: () => void;
}

const JoinPartyModal: React.FC<JoinPartyModalProps> = ({ isOpen, onClose }) => {
    const [code, setCode] = useState('');
    const [isClosing, setIsClosing] = useState(false);
    const navigate = useNavigate();
    const { t } = useTranslation();

    // Disable body scroll when modal is open
    useEffect(() => {
        if (!isOpen) return;

        const originalOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';

        return () => {
            document.body.style.overflow = originalOverflow;
        };
    }, [isOpen]);

    const handleClose = () => {
        setIsClosing(true);
        setTimeout(() => {
            onClose();
            setIsClosing(false);
            setCode('');
        }, 300);
    };

    const handleJoin = (e: React.FormEvent) => {
        e.preventDefault();
        if (code.trim().length >= 3) {
            handleClose();
            navigate(`/watchparty/join/${code.toUpperCase()}`);
        }
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
                        initial={{ scale: 0.9, opacity: 0, y: 20 }}
                        animate={{ scale: 1, opacity: 1, y: 0 }}
                        exit={{ scale: 0.95, opacity: 0, y: 20 }}
                        transition={{ duration: 0.3 }}
                        className="bg-gray-900 border border-white/10 rounded-2xl max-w-md w-full overflow-hidden shadow-2xl relative"
                    >
                        {/* Header */}
                        <div className="p-6 border-b border-white/10 flex justify-between items-center">
                            <h3 className="text-xl font-bold text-white flex items-center gap-2">
                                <Key className="text-red-500 h-5 w-5" />
                                {t('watchParty.joinParty')}
                            </h3>
                            <button
                                onClick={handleClose}
                                className="text-white/50 hover:text-white p-2 rounded-lg hover:bg-white/10 transition-colors"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        {/* Content */}
                        <form onSubmit={handleJoin} className="p-6 space-y-6">
                            <div className="space-y-2">
                                <label htmlFor="code" className="text-sm font-medium text-white/70">
                                    {t('watchParty.roomCode')}
                                </label>
                                <div className="relative">
                                    <Input
                                        id="code"
                                        value={code}
                                        onChange={(e) => setCode(e.target.value.toUpperCase())}
                                        placeholder={t('watchParty.codeExample')}
                                        className="bg-black/50 border-white/10 text-white placeholder:text-white/30 text-center text-2xl tracking-[0.15em] font-mono h-16 uppercase focus-visible:ring-red-500"
                                        maxLength={8}
                                        autoFocus
                                    />
                                    <div className="absolute inset-x-0 bottom-0 h-0.5 bg-gradient-to-r from-transparent via-red-500/50 to-transparent" />
                                </div>
                                <p className="text-xs text-white/40 text-center">
                                    {t('watchParty.enterHostCode')}
                                </p>
                            </div>

                            <motion.div
                                whileHover={{ scale: 1.02 }}
                                whileTap={{ scale: 0.98 }}
                            >
                                <Button
                                    type="submit"
                                    disabled={code.length < 3}
                                    className="w-full h-12 bg-red-600 hover:bg-red-700 text-white font-medium text-lg"
                                >
                                    {t('watchParty.join')}
                                    <ArrowRight className="ml-2 h-5 w-5" />
                                </Button>
                            </motion.div>
                        </form>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );

    return createPortal(modalContent, getOverlayPortalRoot());
};

export default JoinPartyModal;
