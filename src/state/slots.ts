import { create } from 'zustand';

/**
 * Registry mapping a pane id → the DOM element of the grid slot that currently
 * displays it (only the active tab registers slots). A keep-alive terminal
 * portals itself into its slot when present, else into the off-screen holder.
 */
interface SlotsState {
  slots: Record<string, HTMLElement | null>;
  setSlot: (paneId: string, el: HTMLElement | null) => void;
}

export const useSlots = create<SlotsState>((set) => ({
  slots: {},
  setSlot: (paneId, el) =>
    set((s) => {
      if (s.slots[paneId] === el) return s;
      const slots = { ...s.slots };
      if (el) slots[paneId] = el;
      else delete slots[paneId];
      return { slots };
    }),
}));
