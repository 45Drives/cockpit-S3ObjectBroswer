<template>
    <Teleport to="body">
        <div v-if="open" class="fixed inset-0 z-[10000]">
            <div class="absolute inset-0 bg-black/30" @click="emitClose"></div>

            <div
                class="absolute left-1/2 top-1/2 w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-md border border-default bg-default shadow-lg">
                <div class="border-b border-default px-4 py-3">
                    <div class="text-base font-semibold text-default">Rename</div>
                    <div class="text-sm text-muted truncate" :title="subtitle">
                        {{ subtitle }}
                    </div>
                </div>

                <div class="px-4 py-4">
                    <label class="block text-sm text-default mb-2">New name</label>

                    <input v-model.trim="draft" type="text"
                        class="w-full rounded-md border border-default bg-accent px-3 py-2 text-sm text-default shadow-sm focus:outline-none"
                        :disabled="busy" @keyup.enter="onSubmit" />

                    <div v-if="errorText" class="mt-2 text-sm text-red-600">
                        {{ errorText }}
                    </div>

                    <div class="mt-2 text-xs text-muted">
                        Tip: you can include slashes to move the object into another prefix.
                    </div>
                </div>

                <div class="flex items-center justify-end gap-2 border-t border-default px-4 py-3">
                    <button type="button"
                        class="inline-flex items-center justify-center bg-secondary rounded-md border border-default bg-default px-3 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90 disabled:opacity-60"
                        :disabled="busy" @click="emitClose">
                        Cancel
                    </button>

                    <button type="button"
                        class="inline-flex items-center justify-center bg-primary rounded-md border border-default px-3 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90 disabled:opacity-60"
                        :disabled="busy || !draft.trim()" @click="onSubmit">
                        Rename
                    </button>
                </div>
            </div>
        </div>
    </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { sanitize, validate } from "../../lib/helpers";

const props = defineProps<{
    open: boolean;
    busy: boolean;
    initialName: string;     // e.g. file.name
    subtitle?: string;       // e.g. full key shown under title
}>();

const emit = defineEmits<{
    (e: "close"): void;
    (e: "submit", cleanedName: string): void; // cleaned but not prefixed
}>();

const draft = ref("");
const errorText = ref<string | null>(null);

watch(
    () => props.open,
    (open) => {
        if (!open) return;
        draft.value = props.initialName || "";
        errorText.value = null;
    },
    { immediate: true }
);

function emitClose() {
    if (props.busy) return;
    errorText.value = null;
    emit("close");
}



function onSubmit() {
    if (props.busy) return;

    const cleaned = sanitize(draft.value);
    const err = validate(cleaned,{allowSlashes: true});

    if (err) {
        errorText.value = err;
        return;
    }

    errorText.value = null;
    emit("submit", cleaned);
}
</script>