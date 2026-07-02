import type { LayoutPreset } from './types';

export interface LayoutDef {
  id: LayoutPreset;
  label: string;
  /** Number of slots this layout exposes. */
  capacity: number;
  columns: string;
  rows: string;
  /** Slot index (if any) that spans both rows, e.g. the big pane in big1plus2. */
  bigSlot?: number;
}

export const LAYOUTS: Record<LayoutPreset, LayoutDef> = {
  single: { id: 'single', label: '1×1', capacity: 1, columns: '1fr', rows: '1fr' },
  cols2: { id: 'cols2', label: '1×2', capacity: 2, columns: '1fr 1fr', rows: '1fr' },
  rows2: { id: 'rows2', label: '2×1', capacity: 2, columns: '1fr', rows: '1fr 1fr' },
  grid2x2: { id: 'grid2x2', label: '2×2', capacity: 4, columns: '1fr 1fr', rows: '1fr 1fr' },
  big1plus2: {
    id: 'big1plus2',
    label: '1 lớn + 2',
    capacity: 3,
    columns: '1.6fr 1fr',
    rows: '1fr 1fr',
    bigSlot: 0,
  },
  grid3x2: {
    id: 'grid3x2',
    label: '3×2',
    capacity: 6,
    columns: 'repeat(3, 1fr)',
    rows: '1fr 1fr',
  },
};

/** Order shown in the toolbar layout picker (matches the mock). */
export const LAYOUT_ORDER: LayoutPreset[] = [
  'single',
  'cols2',
  'rows2',
  'grid2x2',
  'big1plus2',
  'grid3x2',
];

/** Smallest preset (by capacity) that can hold `count` panes, growing from `current`. */
export function fitLayout(count: number, current: LayoutPreset): LayoutPreset {
  if (LAYOUTS[current].capacity >= count) return current;
  let best = current;
  for (const id of LAYOUT_ORDER) {
    if (LAYOUTS[id].capacity >= count) {
      if (LAYOUTS[best].capacity < count || LAYOUTS[id].capacity < LAYOUTS[best].capacity) {
        best = id;
      }
    }
  }
  return best;
}

/** Rectangles (viewBox 22×16) used to draw each preset's picker icon. */
export const PRESET_RECTS: Record<LayoutPreset, Array<[number, number, number, number]>> = {
  single: [[0, 0, 22, 16]],
  cols2: [
    [0, 0, 10.5, 16],
    [11.5, 0, 10.5, 16],
  ],
  rows2: [
    [0, 0, 22, 7.5],
    [0, 8.5, 22, 7.5],
  ],
  grid2x2: [
    [0, 0, 10.5, 7.5],
    [11.5, 0, 10.5, 7.5],
    [0, 8.5, 10.5, 7.5],
    [11.5, 8.5, 10.5, 7.5],
  ],
  big1plus2: [
    [0, 0, 13, 16],
    [14, 0, 8, 7.5],
    [14, 8.5, 8, 7.5],
  ],
  grid3x2: [
    [0, 0, 6.6, 7.5],
    [7.7, 0, 6.6, 7.5],
    [15.4, 0, 6.6, 7.5],
    [0, 8.5, 6.6, 7.5],
    [7.7, 8.5, 6.6, 7.5],
    [15.4, 8.5, 6.6, 7.5],
  ],
};
