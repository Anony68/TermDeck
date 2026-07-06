import type { FontSize } from './types';

export const FONT_PX: Record<FontSize, number> = {
  small: 11,
  medium: 12.5,
  large: 14,
};

// Font-size labels are translated via i18n keys `font.small|medium|large`.

export const FONT_ORDER: FontSize[] = ['small', 'medium', 'large'];
