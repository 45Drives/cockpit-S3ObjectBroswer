<template>
    <div v-if="open" class="fixed inset-0 z-50">
        <div class="absolute inset-0 bg-black/40" @click="emit('close')" />

        <div class="absolute inset-0 flex items-center justify-center overflow-auto p-6">
            <div class="w-full max-w-lg rounded-md border border-default bg-accent shadow-lg">
                <div class="border-b border-default px-5 py-4">
                    <h2 class="text-base font-semibold text-default">Change storage class</h2>
                    <p class="mt-1 text-sm text-default">
                        Select the new storage class for
                        <span class="font-medium">{{ keyLabel }}</span>.
                    </p>
                </div>

                <div class="space-y-4 px-5 py-4 text-sm">
                    <div>
                        <label class="block text-default font-medium mb-1">Storage class</label>

                        <select v-model="selected"
                            class="block w-full rounded-md border border-default bg-default px-3 py-2 text-sm text-default shadow-sm"
                            :disabled="busy">
                            <option v-for="opt in options" :key="opt" :value="opt">
                                {{ opt }}
                            </option>
                            <option value="__custom__">Custom…</option>
                        </select>

                        <div v-if="selected === '__custom__'" class="mt-2">
                            <input v-model.trim="custom" type="text"
                                placeholder="Enter storage class (e.g. STANDARD_IA)"
                                class="block w-full rounded-md border border-default bg-default px-3 py-2 text-sm text-default shadow-sm"
                                :disabled="busy" />
                        </div>

                        <p v-if="localError" class="mt-2 text-red-700">
                            {{ localError }}
                        </p>
                    </div>

                    <div v-if="selected === '__custom__'"
                        class="rounded-md border border-default bg-default p-3 text-xs text-default">
                        Examples: STANDARD, STANDARD_IA, ONEZONE_IA, INTELLIGENT_TIERING, GLACIER, DEEP_ARCHIVE
                    </div>
                </div>

                <div class="flex justify-end gap-2 px-5 py-4 border-t border-default">
                    <button type="button"
                        class="inline-flex items-center justify-center btn-secondary rounded-md border border-default bg-default px-4 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90 active:opacity-80 disabled:opacity-60"
                        :disabled="busy" @click="emit('close')">
                        Cancel
                    </button>

                    <button type="button"
                        class="inline-flex items-center justify-center rounded-md border border-default btn-primary px-4 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90 active:opacity-80 disabled:opacity-60"
                        :disabled="busy" @click="submit">
                        Apply
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";

type Props = {
    open: boolean;
    busy?: boolean;
    current?: string | null;
    keyLabel?: string;
    options?: string[];
};

const props = withDefaults(defineProps<Props>(), {
    busy: false,
    current: null,
    keyLabel: "",
    options: () => [
        "STANDARD",
        "STANDARD_IA",
        "ONEZONE_IA",
        "INTELLIGENT_TIERING",
        "GLACIER",
        "DEEP_ARCHIVE",
    ],
});

const emit = defineEmits<{
    (e: "close"): void;
    (e: "submit", value: string): void;
}>();

const selected = ref<string>("STANDARD");
const custom = ref<string>("");
const localError = ref<string>("");

watch(
    () => props.open,
    (o) => {
        if (!o) return;
        localError.value = "";

        const cur = (props.current || "STANDARD").trim() || "STANDARD";
        if (props.options.includes(cur)) {
            selected.value = cur;
            custom.value = "";
        } else {
            selected.value = "__custom__";
            custom.value = cur;
        }
    },
    { immediate: true }
);

const finalValue = computed(() => {
    if (selected.value === "__custom__") return (custom.value || "").trim();
    return (selected.value || "").trim();
});

function submit() {
    localError.value = "";
    const v = finalValue.value;

    if (!v) {
        localError.value = "Storage class is required.";
        return;
    }

    emit("submit", v);
}
</script>