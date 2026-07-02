import type { FontSize } from './types';

export const FONT_PX: Record<FontSize, number> = {
  small: 11,
  medium: 12.5,
  large: 14,
};

export const FONT_LABEL: Record<FontSize, string> = {
  small: 'Nhỏ',
  medium: 'Vừa',
  large: 'Lớn',
};

export const FONT_ORDER: FontSize[] = ['small', 'medium', 'large'];
