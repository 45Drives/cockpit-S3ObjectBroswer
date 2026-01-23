<template>
  <Teleport to="body">
    <div v-if="open" class="fixed inset-0 z-[10000]">
      <!-- backdrop -->
      <div class="absolute inset-0 bg-black/40" @click="onCancel" />

      <!-- dialog -->
      <div class="absolute inset-0 flex items-center justify-center p-4">
        <div class="w-full max-w-md rounded-md border border-default bg-default shadow-lg" role="dialog"
          aria-modal="true" @keydown.esc.prevent="onCancel" tabindex="-1" ref="dialogEl">
          <div class="border-b border-default px-4 py-3">
            <div class="text-base font-semibold text-default">
              {{ busy ? "Deleting…" : "Confirm delete" }}
            </div>
          </div>

          <div class="px-4 py-4">
            <div class="text-sm text-default">
              <template v-if="busy">
                <div>Please wait while the delete completes.</div>
                <div v-if="progressText" class="mt-2 text-xs text-muted">
                  {{ progressText }}
                </div>
              </template>

              <template v-else>
                <div class="text-default">
                  <template v-if="kind === 'folder'">
                    Delete folder <span class="font-semibold">{{ name }}/</span> and everything inside it?
                  </template>
                  <template v-else>
                    Delete file <span class="font-semibold">{{ name }}</span>?
                  </template>
                </div>

                <div class="mt-2 text-xs text-muted">
                  This cannot be undone.
                </div>
              </template>
            </div>
          </div>

          <div class="border-t border-default px-4 py-3 flex items-center justify-end gap-2">
            <button type="button"
              class="inline-flex items-center btn-secondary justify-center rounded-md border border-default bg-default px-3 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90 active:opacity-80 disabled:opacity-60"
              :disabled="busy" @click="onCancel">
              Cancel
            </button>

            <button type="button"
              class="inline-flex items-center justify-center rounded-md border border-default bg-danger px-3 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90 active:opacity-80 disabled:opacity-60"
              :disabled="busy" @click="onConfirm">
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from "vue";

type DeleteKind = "file" | "folder";

const props = defineProps<{
  open: boolean;
  kind: DeleteKind;
  name: string;
  busy?: boolean;
  progressText?: string;
}>();

const emit = defineEmits<{
  (e: "cancel"): void;
  (e: "confirm"): void;
}>();

const dialogEl = ref<HTMLElement | null>(null);

function onCancel() {
  if (props.busy) return;
  emit("cancel");
}

function onConfirm() {
  if (props.busy) return;
  emit("confirm");
}

watch(
  () => props.open,
  async (v) => {
    if (!v) return;
    await nextTick();
    dialogEl.value?.focus();
  }
);
</script>