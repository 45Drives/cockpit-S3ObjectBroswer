import { defineStore } from "pinia";

export type DeleteKind = "file" | "folder";

export type DeletePrefixEvent =
  | { type: "start"; ok: boolean; prefix?: string }
  | { type: "progress"; ok: boolean; deletedRequested?: number; errors?: number }
  | { type: "result"; ok: boolean; deletedRequested?: number; errors?: number; error?: string };

export type DeleteTask = {
  id: string;

  // helps avoid collisions + helps decide whether to refresh current page
  connectionId: string;
  bucket: string;

  kind: DeleteKind;

  key?: string;
  prefix?: string;

  name: string;

  busy: boolean;
  progress: string;
  error: string;

  deletedRequested?: number;
  errorsCount?: number;

  startedAt: number;
  finishedAt?: number;

  abort?: AbortController;
};

function taskIdFor(t: { kind: DeleteKind; connectionId: string; bucket: string; key?: string; prefix?: string }) {
  return t.kind === "folder"
    ? `folder:${t.connectionId}:${t.bucket}:${t.prefix || ""}`
    : `file:${t.connectionId}:${t.bucket}:${t.key || ""}`;
}

export const useDeleteTasksStore = defineStore("deleteTasks", {
  state: () => ({
    tasks: new Map<string, DeleteTask>(),
  }),

  getters: {
    hasAny(state): boolean {
      return state.tasks.size > 0;
    },
    list(state): DeleteTask[] {
      return Array.from(state.tasks.values()).sort((a, b) => b.startedAt - a.startedAt);
    },
    runningCount(state): number {
      let n = 0;
      for (const t of state.tasks.values()) if (t.busy) n += 1;
      return n;
    },
  },

  actions: {
    upsert(task: DeleteTask) {
      this.tasks.set(task.id, task);
    },

    patch(id: string, patch: Partial<DeleteTask>) {
      const cur = this.tasks.get(id);
      if (!cur) return;
      this.tasks.set(id, { ...cur, ...patch });
    },

    remove(id: string) {
      this.tasks.delete(id);
    },

    clearFinished() {
      for (const [id, t] of this.tasks) {
        if (!t.busy) this.tasks.delete(id);
      }
    },

    cancel(id: string) {
      const t = this.tasks.get(id);
      if (!t) return;
      if (t.busy) {
        try {
          t.abort?.abort();
        } catch {}
        this.patch(id, { busy: false, progress: "Canceled.", finishedAt: Date.now() });
      }
    },

    createTask(input: {
      connectionId: string;
      bucket: string;
      kind: DeleteKind;
      name: string;
      key?: string;
      prefix?: string;
    }): DeleteTask {
      const id = taskIdFor({
        kind: input.kind,
        connectionId: input.connectionId,
        bucket: input.bucket,
        key: input.key,
        prefix: input.prefix,
      });

      const existing = this.tasks.get(id);
      if (existing?.busy) return existing;

      const task: DeleteTask = {
        id,
        connectionId: input.connectionId,
        bucket: input.bucket,
        kind: input.kind,
        key: input.key,
        prefix: input.prefix,
        name: input.name,
        busy: true,
        progress: input.kind === "folder" ? "Deleting objects under the folder…" : "Deleting file…",
        error: "",
        startedAt: Date.now(),
      };

      this.upsert(task);
      return task;
    },

    // Runner: you pass in your deletePrefixStreamed/deleteObject functions
    async run(task: DeleteTask, deps: {
      deletePrefixStreamed: (p: {
        connectionId: string;
        bucket: string;
        prefix: string;
        onEvent: (ev: DeletePrefixEvent) => void;
      }) => any; // ResultAsync
      deleteObject: (p: { connectionId: string; bucket: string; key: string }) => any; // ResultAsync
    }) {
      const ac = new AbortController();
      this.patch(task.id, { abort: ac });

      try {
        if (task.kind === "folder") {
          let lastUiUpdate = 0;

          const res = await deps.deletePrefixStreamed({
            connectionId: task.connectionId,
            bucket: task.bucket,
            prefix: task.prefix || "",
            onEvent: (ev) => {
              // show start too (optional)
              if (ev.type === "start") {
                this.patch(task.id, { progress: "Deleting…", error: "" });
                return;
              }

              if (ev.type !== "progress") return;

              const now = Date.now();
              if (now - lastUiUpdate < 250) return;
              lastUiUpdate = now;

              const d = Number(ev.deletedRequested ?? 0);
              const e = Number(ev.errors ?? 0);

              this.patch(task.id, {
                deletedRequested: d,
                errorsCount: e,
                progress: `Deleted ${d} objects so far…`,
                error: e > 0 ? `${e} objects failed to delete.` : "",
              });
            },
          });

          if (res.isErr()) {
            this.patch(task.id, { error: res.error.message, progress: "Failed.", busy: false, finishedAt: Date.now() });
            return;
          }

          if (res.value.errors > 0) {
            this.patch(task.id, {
              progress: `Done. Requested delete of ${res.value.deletedRequested} objects.`,
              error: `${res.value.errors} objects failed to delete.`,
              deletedRequested: res.value.deletedRequested,
              errorsCount: res.value.errors,
              busy: false,
              finishedAt: Date.now(),
            });
          } else {
            this.patch(task.id, {
              progress: `Done. Deleted ${res.value.deletedRequested} objects.`,
              error: "",
              deletedRequested: res.value.deletedRequested,
              errorsCount: 0,
              busy: false,
              finishedAt: Date.now(),
            });
          }
        } else {
          const res = await deps.deleteObject({
            connectionId: task.connectionId,
            bucket: task.bucket,
            key: task.key || "",
          });

          if (res.isErr()) {
            this.patch(task.id, { error: res.error.message, progress: "Failed.", busy: false, finishedAt: Date.now() });
            return;
          }

          this.patch(task.id, { progress: "Deleted.", busy: false, finishedAt: Date.now() });
        }
      } finally {
        this.patch(task.id, { abort: undefined });
      }
    },
  },
});
