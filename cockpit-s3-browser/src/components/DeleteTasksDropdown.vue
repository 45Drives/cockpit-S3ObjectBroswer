<template>
    <div v-if="store.hasAny" class="relative">
      <button
        type="button"
        class="inline-flex items-center rounded-md border border-default bg-default px-3 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90 active:opacity-80"
        @click="open = !open"
      >
        Delete Tasks
        <span v-if="store.runningCount" class="ml-2 rounded-full border border-default px-2 py-0.5 text-xs">
          {{ store.runningCount }}
        </span>
      </button>
  
      <div
        v-if="open"
        class="absolute right-0 mt-2 w-[420px] max-w-[90vw] rounded-md border border-default bg-default shadow-lg"
      >
        <div class="flex items-center justify-between border-b border-default px-3 py-2">
          <div class="text-sm font-semibold text-default">Delete tasks</div>
  
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="rounded-md border border-default px-2 py-1 text-xs font-semibold text-default hover:opacity-90"
              @click="store.clearFinished()"
              :disabled="store.runningCount > 0"
              title="Clears completed tasks (disabled while tasks are running)"
            >
              Clear done
            </button>
  
            <button
              type="button"
              class="rounded-md border border-default px-2 py-1 text-xs font-semibold text-default hover:opacity-90"
              @click="open = false"
            >
              Close
            </button>
          </div>
        </div>
  
        <div class="max-h-[60vh] overflow-auto p-2">
          <div
            v-for="t in store.list"
            :key="t.id"
            class="mb-2 rounded-md border border-default bg-accent px-3 py-2 text-sm"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="font-semibold text-default truncate">
                  {{ t.kind === "folder" ? "Folder" : "File" }}: {{ t.name }}
                </div>
                <div class="text-xs text-default opacity-80 truncate">
                  {{ t.connectionId }} · {{ t.bucket }}
                  <span v-if="t.kind === 'folder'"> · {{ t.prefix }}</span>
                  <span v-else> · {{ t.key }}</span>
                </div>
  
                <div class="mt-1 text-sm text-default">
                  {{ t.progress }}
                </div>
  
                <div v-if="t.error" class="mt-1 text-xs text-red-700">
                  {{ t.error }}
                </div>
              </div>
  
              <div class="shrink-0 text-right">
                <div class="text-xs opacity-80">
                  {{ t.busy ? "Running" : (t.error ? "Done (with errors)" : "Done") }}
                </div>
  
                <button
                  v-if="t.busy"
                  type="button"
                  class="mt-2 rounded-md border border-default px-2 py-1 text-xs font-semibold text-default hover:opacity-90"
                  @click="store.cancel(t.id)"
                >
                  Cancel
                </button>
  
                <button
                  v-else
                  type="button"
                  class="mt-2 rounded-md border border-default px-2 py-1 text-xs font-semibold text-default hover:opacity-90"
                  @click="store.remove(t.id)"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
  
          <div v-if="store.list.length === 0" class="p-3 text-sm text-default opacity-80">
            No tasks.
          </div>
        </div>
      </div>
    </div>
</template>
  
  <script setup lang="ts">
  import { ref, onBeforeUnmount } from "vue";
  import { useDeleteTasksStore } from "../stores/deleteTasks";
  
  const store = useDeleteTasksStore();
  const open = ref(false);
  
  // optional: close on route change, outside click, etc. (not required)
  onBeforeUnmount(() => {
    open.value = false;
  });
  </script>
  