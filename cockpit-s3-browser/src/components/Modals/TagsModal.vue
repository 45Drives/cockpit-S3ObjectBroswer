<template>
    <Teleport to="body">
        <div v-if="open" class="fixed inset-0 z-[9999]">
            <div class="absolute inset-0 bg-black/40" @click="emitClose"></div>

            <div class="absolute inset-0 flex items-center justify-center p-4">
                <div class="w-full max-w-xl overflow-hidden rounded-lg border border-default bg-accent shadow-lg">
                    <div class="flex items-center justify-between border-b border-default px-4 py-3">
                        <div class="min-w-0">
                            <div class="truncate text-sm font-semibold text-default">Tags</div>
                            <div class="truncate text-xs text-muted">{{ title }}</div>
                        </div>
                    </div>

                    <div class="px-4 py-3">
                        <div v-if="busy" class="text-sm text-muted">Loading…</div>

                        <div v-else class="space-y-2">
                            <div v-if="rows.length === 0" class="text-sm text-muted">
                                No tags.
                            </div>

                            <div v-for="(t, idx) in rows" :key="idx" class="flex gap-2">
                                <input
                                    class="w-1/2 rounded border border-default bg-default px-2 py-1 text-sm text-default outline-none"
                                    placeholder="Key" v-model="t.key" />
                                <input
                                    class="w-1/2 rounded border border-default bg-default px-2 py-1 text-sm text-default outline-none"
                                    placeholder="Value" v-model="t.value" />
                                <button type="button"
                                    class=" px-2 py-1 text-red-700 text-sm  hover:text-default"
                                    @click="removeRow(idx)" title="Remove">
                                    <TrashIcon class="h-4 w-4"></TrashIcon>

                                </button>
                            </div>

                            <div class="pt-2">
                                <button type="button"
                                    class="rounded border border-default px-3 py-1.5 text-sm btn-secondary text-default hover:bg-accent"
                                    @click="addRow()">
                                    <PlusIcon class="h-4 w-4"></PlusIcon>
                                </button>
                            </div>

                            <div v-if="localError" class="pt-2 text-sm text-red-700">
                                {{ localError }}
                            </div>
                        </div>
                    </div>

                    <div class="flex items-center justify-end gap-2 border-t border-default px-4 py-3">
                        <button type="button"
                            class="rounded border border-default font-semibold px-3 py-1.5 btn-secondary text-sm text-default hover:bg-accent"
                            @click="emitClose">
                            Cancel
                        </button>

                        <button type="button"
                            class="rounded bg-accent px-3 py-1.5 text-sm text-default btn-primary font-semibold disabled:opacity-50"
                            :disabled="busy || saving" @click="save">
                            Save
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { PlusIcon, TrashIcon } from "@heroicons/vue/20/solid";

export type TagKV = { key: string; value: string };

const props = defineProps<{
    open: boolean;
    busy?: boolean;
    title?: string;
    tags: TagKV[];
}>();

const emit = defineEmits<{
    (e: "close"): void;
    (e: "save", payload: { tags: TagKV[] }): void;
}>();

const rows = ref<TagKV[]>([]);
const localError = ref<string>("");
const saving = ref(false);

const title = computed(() => props.title || "");

watch(
    () => props.open,
    (isOpen) => {
        if (!isOpen) return;
        rows.value = (props.tags || []).map((t) => ({ key: t.key, value: t.value }));
        localError.value = "";
        saving.value = false;
    },
    { immediate: true }
);

function emitClose() {
    emit("close");
}

function addRow() {
    rows.value.push({ key: "", value: "" });
}

function removeRow(i: number) {
    rows.value.splice(i, 1);
}

function normalize(input: TagKV[]): TagKV[] {
    const out: TagKV[] = [];
    const seen = new Set<string>();

    for (const t of input) {
        const k = (t.key || "").trim();
        const v = String(t.value ?? "");
        if (!k) continue;

        // de-dupe by key, last one wins
        if (seen.has(k)) {
            const idx = out.findIndex((x) => x.key === k);
            if (idx >= 0) out[idx] = { key: k, value: v };
            continue;
        }

        seen.add(k);
        out.push({ key: k, value: v });
    }

    return out;
}

async function save() {
    localError.value = "";
    saving.value = true;
    try {
        const normalized = normalize(rows.value);
        emit("save", { tags: normalized });
    } finally {
        saving.value = false;
    }
}
</script>