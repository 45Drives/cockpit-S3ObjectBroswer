<!-- src/components/Modals/NewFolderModal.vue -->
<template>
    <Teleport to="body">
        <div v-if="open" class="fixed inset-0 z-[10000]">
            <div class="absolute inset-0 bg-black/30" @click="requestClose" />

            <div
                class="absolute left-1/2 top-1/2 w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-md border border-default bg-default shadow-lg">
                <div class="border-b border-default px-4 py-3">
                    <div class="text-base font-semibold text-default">New folder</div>
                    <div class="text-sm text-muted">Create a folder under {{ prefixLabel }}</div>
                </div>

                <div class="px-4 py-4">
                    <label class="block text-sm text-default mb-2">Folder name</label>

                    <input v-model.trim="localName" type="text"
                        class="w-full rounded-md border border-default bg-accent px-3 py-2 text-sm text-default shadow-sm focus:outline-none"
                        placeholder="e.g. invoices" :disabled="busy" @input="errorMsg = ''" @keyup.enter="submit" />

                    <div v-if="errorMsg" class="mt-2 text-sm text-red-600">
                        {{ errorMsg }}
                    </div>
                </div>

                <div class="flex items-center justify-end gap-2 border-t border-default px-4 py-3">
                    <button type="button"
                        class="inline-flex items-center justify-center bg-secondary rounded-md border border-default bg-default px-3 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90 disabled:opacity-60"
                        :disabled="busy" @click="requestClose">
                        Cancel
                    </button>

                    <button type="button"
                        class="inline-flex items-center bg-primary justify-center rounded-md border border-default px-3 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90 disabled:opacity-60"
                        :disabled="busy || !localName.trim()" @click="submit">
                        Create
                    </button>
                </div>
            </div>
        </div>
    </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { sanitize, validate } from "../../lib/helpers";

const props = withDefaults(
    defineProps<{
        open: boolean;
        busy?: boolean;
        prefix?: string;
        name?: string;
    }>(),
    { busy: false, prefix: "", name: "" }
);

const emit = defineEmits<{
    (e: "close"): void;
    (e: "create", payload: { name: string }): void;
}>();

const localName = ref(props.name || "");
const errorMsg = ref("");

watch(
    () => props.open,
    (open) => {
        if (open) {
            localName.value = props.name || "";
            errorMsg.value = "";
        }
    }
);

const prefixLabel = computed(() => (props.prefix && props.prefix.length ? props.prefix : "/"));

function requestClose() {
    if (props.busy) return;
    emit("close");
}

function submit() {
    if (props.busy) return;

    const cleaned = sanitize(localName.value);
    const v = validate(cleaned,{allowslashes:false});
    if (v) {
        errorMsg.value = v;
        return;
    }

    emit("create", { name: cleaned });
}
</script>