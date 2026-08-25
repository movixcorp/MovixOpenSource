import React from 'react';
import { Info, ThumbsDown, ThumbsUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ReusableModal from './ui/reusable-modal';

interface MovixRatingInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const MovixRatingInfoModal: React.FC<MovixRatingInfoModalProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation();

  return (
    <ReusableModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('details.movixRatingInfoTitle')}
      className="max-w-lg"
    >
      <div className="space-y-5 text-gray-300">
        <div className="flex items-start gap-3 rounded-xl border border-red-500/20 bg-red-500/10 p-4">
          <Info className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-400" />
          <p className="text-sm leading-6 text-red-100/90">
            {t('details.movixRatingInfoDescription')}
          </p>
        </div>

        <div className="rounded-xl border border-white/10 bg-white/5 p-4">
          <p className="mb-2 text-sm font-semibold text-white">
            {t('details.movixRatingInfoFormulaLabel')}
          </p>
          <p className="font-mono text-sm text-red-300">
            {t('details.movixRatingInfoFormula')}
          </p>
          <p className="mt-2 text-xs leading-5 text-white/60">
            {t('details.movixRatingInfoRounding')}
          </p>
        </div>

        <div className="space-y-3 text-sm leading-6 text-white/75">
          <div className="flex items-start gap-3">
            <ThumbsUp className="mt-1 h-4 w-4 flex-shrink-0 text-green-400" />
            <p>{t('details.movixRatingInfoLikes')}</p>
          </div>
          <div className="flex items-start gap-3">
            <ThumbsDown className="mt-1 h-4 w-4 flex-shrink-0 text-red-400" />
            <p>{t('details.movixRatingInfoDislikes')}</p>
          </div>
        </div>
      </div>
    </ReusableModal>
  );
};

export default MovixRatingInfoModal;
