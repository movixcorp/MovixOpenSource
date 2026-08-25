import * as DialogPrimitive from '@radix-ui/react-dialog';
import { BatteryCharging, Wifi } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import {
  continueCastRelayDisclosure,
  openCastRelayBatterySettings,
} from '@/utils/castRelayDisclosure';
import { getOverlayPortalRoot } from '@/utils/overlayPortal';

export interface CastRelayDisclosureProps {
  open: boolean;
  onContinue: () => void;
  onOpenBatterySettings: () => void | Promise<void>;
  onSetSuppressed: (suppressed: boolean) => void | Promise<void>;
  onRequestNotificationPermission?: () => void | Promise<void>;
}

/**
 * A non-blocking explanation shown before an Android-native Cast attempt.
 * The preference changes only when the viewer explicitly selects the checkbox.
 */
export function CastRelayDisclosure({
  open,
  onContinue,
  onOpenBatterySettings,
  onSetSuppressed,
  onRequestNotificationPermission = () => undefined,
}: CastRelayDisclosureProps) {
  const { t } = useTranslation();
  const [suppress, setSuppress] = useState(false);

  useEffect(() => {
    if (open) setSuppress(false);
  }, [open]);

  const handleContinue = () => {
    continueCastRelayDisclosure({
      suppress,
      setSuppressed: onSetSuppressed,
      requestNotificationPermission: onRequestNotificationPermission,
      onContinue,
    });
  };

  const handleBatterySettings = () => {
    openCastRelayBatterySettings({
      openBatterySettings: onOpenBatterySettings,
    });
  };

  return (
    <DialogPrimitive.Root open={open}>
      <DialogPrimitive.Portal container={getOverlayPortalRoot()}>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[100000] bg-black/80 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 duration-200 motion-reduce:animate-none" />
        <DialogPrimitive.Content
          aria-describedby="cast-relay-disclosure-description"
          className="fixed left-1/2 top-1/2 z-[100001] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-white/10 bg-gray-900/95 p-6 shadow-2xl backdrop-blur-md focus:outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 duration-200 motion-reduce:animate-none"
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-red-500/15 p-2.5 text-red-300">
              <Wifi className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <DialogPrimitive.Title className="text-lg font-semibold text-white">
                {t('watch.castRelayDisclosureTitle')}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description
                id="cast-relay-disclosure-description"
                className="mt-1 text-sm leading-6 text-white/70"
              >
                {t('watch.castRelayDisclosureBody')}
              </DialogPrimitive.Description>
            </div>
          </div>

          <div className="mt-5 space-y-3 rounded-lg border border-white/10 bg-white/[0.03] p-4 text-sm leading-6 text-white/75">
            <p>{t('watch.castRelayDisclosureWifi')}</p>
            <p>{t('watch.castRelayDisclosureBattery')}</p>
            <p>{t('watch.castRelayDisclosurePlugIn')}</p>
            <div className="flex gap-2 text-white/80">
              <BatteryCharging className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
              <p>{t('watch.castRelayDisclosureUnrestrictedBattery')}</p>
            </div>
            <p className="text-xs text-white/55">{t('watch.castRelayDisclosureOptional')}</p>
          </div>

          <label className="mt-5 flex cursor-pointer items-center gap-3 text-sm text-white/80">
            <Checkbox
              checked={suppress}
              onCheckedChange={setSuppress}
              aria-label={t('watch.castRelayDisclosureDoNotShowAgain')}
            />
            <span>{t('watch.castRelayDisclosureDoNotShowAgain')}</span>
          </label>

          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={handleBatterySettings}>
              {t('watch.castRelayDisclosureBatterySettings')}
            </Button>
            <Button type="button" onClick={handleContinue}>
              {t('watch.castRelayDisclosureContinue')}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
