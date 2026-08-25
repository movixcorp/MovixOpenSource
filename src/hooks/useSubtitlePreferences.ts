import { useCallback, useEffect, useRef, useState } from 'react';
import {
  loadSubtitlePreferences,
  normalizeSubtitlePreferences,
  resetSubtitleAppearance,
  saveSubtitlePreferences,
  SUBTITLE_STYLE_CHANGED_EVENT,
  SUBTITLE_STYLE_PREVIEW_EVENT,
  SUBTITLE_STYLE_STORAGE_KEY,
  type SubtitlePreferencePatch,
  type SubtitlePreferences,
} from '@/utils/subtitlePreferences';
import { ensureSubtitleFontLoaded } from '@/utils/subtitleFontLoader';

export interface UseSubtitlePreferencesResult {
  preferences: SubtitlePreferences;
  patchPreferences: (patch: SubtitlePreferencePatch) => void;
  previewPreferences: (patch: SubtitlePreferencePatch) => void;
  commitPreferences: () => void;
  setPreferences: (updater: SubtitlePreferences | ((current: SubtitlePreferences) => SubtitlePreferences)) => void;
  resetAppearance: () => void;
}

export function useSubtitlePreferences(): UseSubtitlePreferencesResult {
  const [preferences, setState] = useState<SubtitlePreferences>(() => loadSubtitlePreferences());
  const preferencesRef = useRef(preferences);

  useEffect(() => {
    const refresh = (event?: Event) => {
      if (event instanceof StorageEvent && event.key !== SUBTITLE_STYLE_STORAGE_KEY) return;
      if (event instanceof CustomEvent && event.detail) {
        const next = normalizeSubtitlePreferences(event.detail);
        preferencesRef.current = next;
        setState(next);
        return;
      }
      const next = loadSubtitlePreferences();
      preferencesRef.current = next;
      setState(next);
    };
    window.addEventListener(SUBTITLE_STYLE_CHANGED_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(SUBTITLE_STYLE_CHANGED_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  useEffect(() => {
    ensureSubtitleFontLoaded(preferences.fontFamily);
  }, [preferences.fontFamily]);

  const setPreferences = useCallback<UseSubtitlePreferencesResult['setPreferences']>((updater) => {
    const current = preferencesRef.current;
    const requested = typeof updater === 'function' ? updater(current) : updater;
    const next = normalizeSubtitlePreferences(requested);
    preferencesRef.current = next;
    setState(next);
    saveSubtitlePreferences(next);
  }, []);

  const patchPreferences = useCallback((patch: SubtitlePreferencePatch) => {
    setPreferences((current) => ({ ...current, ...patch }));
  }, [setPreferences]);

  const previewPreferences = useCallback((patch: SubtitlePreferencePatch) => {
    const next = normalizeSubtitlePreferences({ ...preferencesRef.current, ...patch });
    preferencesRef.current = next;
    window.dispatchEvent(new CustomEvent(SUBTITLE_STYLE_PREVIEW_EVENT, { detail: next }));
  }, []);

  const commitPreferences = useCallback(() => {
    saveSubtitlePreferences(preferencesRef.current);
  }, []);

  const resetAppearance = useCallback(() => {
    setPreferences((current) => resetSubtitleAppearance(current));
  }, [setPreferences]);

  return {
    preferences,
    patchPreferences,
    previewPreferences,
    commitPreferences,
    setPreferences,
    resetAppearance,
  };
}
