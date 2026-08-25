import React from 'react';
import { AgeClassifiableContent } from '../utils/contentAgeFilter';
import { useAgeRestrictedContent } from '../hooks/useAgeRestrictedContent';

interface AgeRestrictedMediaProps<T extends AgeClassifiableContent> {
  item: T;
  children: React.ReactNode;
}

/**
 * Small guard for media cards that are not rendered through the shared search
 * or carousel components. It keeps the card out of the DOM until the active
 * profile's age restriction has been checked.
 */
const AgeRestrictedMedia = <T extends AgeClassifiableContent>({ item, children }: AgeRestrictedMediaProps<T>) => {
  const { items } = useAgeRestrictedContent([item]);
  return items.length > 0 ? <>{children}</> : null;
};

export default AgeRestrictedMedia;
