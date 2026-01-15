import { defineStore } from "pinia";
import { ClipboardState, ClipItem, ClipKind } from "../types";

export const useClipboardStore = defineStore("clipboard", {
  state: (): ClipboardState => ({kind: null,connectionId: "",bucket: "",items: [],createdAt: 0,
  }),

  getters: {
    hasItems(state) {
      return state.items.length > 0 && !!state.kind;
    },

    canPaste: (state) => (connectionId: string, bucket: string) => {
      if (!state.kind || state.items.length === 0) return false;
      return state.connectionId === connectionId && state.bucket === bucket;
    },
  },

  actions: {
    set(kind: ClipKind, connectionId: string, bucket: string, items: ClipItem[]) {
      this.kind = kind;
      this.connectionId = connectionId;
      this.bucket = bucket;
      this.items = items;
      this.createdAt = Date.now();
    },

    clear() {
      this.kind = null;
      this.connectionId = "";
      this.bucket = "";
      this.items = [];
      this.createdAt = 0;
    },
  },
});
