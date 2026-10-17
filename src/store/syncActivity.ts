import { create } from 'zustand';

/** What a running sync is doing right now, per workspace, for the UI. Not persisted. */
interface ISyncActivityState {
  /** Workspaces whose sync is currently tidying up the local Git repository. */
  housekeeping: Partial<Record<string, boolean>>;
  setHousekeeping: (workspaceId: string, running: boolean) => void;
}

export const useSyncActivityStore = create<ISyncActivityState>()(set => ({
  housekeeping: {},
  setHousekeeping: (workspaceId, running) => {
    set(state => ({ housekeeping: { ...state.housekeeping, [workspaceId]: running } }));
  },
}));
