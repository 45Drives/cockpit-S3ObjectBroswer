<!-- src/components/TaskCenter.vue -->
<template>
    <div v-if="taskCenter.hasAny" class="relative w-full" ref="root">
        <div class="w-full text-right">
            <button type="button"
                class="inline-flex items-center rounded-md border border-default bg-default px-3 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90 active:opacity-80"
                @click="open = !open">
                Tasks

                <span v-if="taskCenter.activeTotal > 0" class="ml-2 inline-flex items-center gap-1">
                    <button v-for="b in badges" :key="b.kind" type="button"
                        class="rounded-full border border-default px-2 py-0.5 text-xs font-semibold"
                        :class="b.className" @click.stop="toggleFilter(b.kind)" :title="b.label">
                        {{ b.short }} {{ b.count }}
                    </button>
                </span>
            </button>
        </div>

        <div v-if="open" class="absolute right-0 mt-2 w-[30rem] rounded-md border border-default bg-default shadow-lg"
            style="z-index: 1;">
            <div class="flex items-center justify-between border-b border-default px-3 py-2">
                <div class="text-sm font-semibold text-default">
                    Tasks
                    <span v-if="filterKind" class="ml-2 text-xs opacity-80">
                        (filtered: {{ filterKind }})
                    </span>
                </div>

                <div class="flex items-center gap-2">
                    <button v-if="filterKind" type="button"
                        class="rounded-md border border-default px-2 py-1 text-xs font-semibold text-default hover:opacity-90"
                        @click="filterKind = null">
                        Clear filter
                    </button>

                    <button type="button"
                        class="rounded-md border border-default px-2 py-1 text-xs font-semibold text-default hover:opacity-90"
                        @click="open = false">
                        Close
                    </button>
                </div>
            </div>

            <div class="max-h-[60vh] overflow-auto p-2 w-full">
                <div v-for="t in visibleTasks" :key="t.id"
                    class="mb-2 rounded-md border border-default bg-accent px-3 py-2 text-sm">
                    <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0 w-full">
                            <div class="font-semibold text-default truncate">
                                <span class="mr-2 rounded-full border border-default px-2 py-0.5 text-xs"
                                    :class="kindBadgeClass(t.kind)">
                                    {{ kindLabel(t.kind) }}
                                </span>
                                {{ t.name }}
                            </div>
                            <div class="mt-1 text-sm text-default">
                                {{ t.progressText || stateLabel(t.state) }}
                            </div>
                            <div v-if="pctFor(t) != null" class="mt-2">
  <div class="h-4 w-full rounded bg-well overflow-hidden">
    <div class="h-4 bg-secondary transition-[width] duration-200" :style="{ width: pctFor(t) + '%' }"></div>
  </div>

  <div
    v-if="typeof t.progressCurrent === 'number' && typeof t.progressTotal === 'number' && t.progressTotal > 0"
    class="mt-1 flex items-center justify-between text-xs opacity-80"
  >
    <span>{{ formatBytes(t.progressCurrent) }} / {{ formatBytes(t.progressTotal) }}</span>
    <span>{{ pctFor(t) }}%</span>
  </div>
</div>





                            <div v-if="t.error" class="mt-1 text-xs text-red-700">
                                {{ t.error }}
                            </div>
                        </div>

                        <div class="shrink-0 text-right">
                            <div class="text-xs opacity-80">{{ stateLabel(t.state) }}</div>

                            <button v-if="t.state === 'running' || t.state === 'canceling'" type="button"
                                class="mt-2 rounded-md border border-default px-2 py-1 text-xs font-semibold text-default hover:opacity-90"
                                :disabled="t.state === 'canceling' || !t.actions?.cancel" @click="onCancel(t)">
                                {{ t.state === "canceling" ? "Canceling…" : "Cancel" }}
                            </button>

                            <button v-else type="button"
                                class="mt-2 rounded-md border border-default px-2 py-1 text-xs font-semibold text-default hover:opacity-90"
                                :disabled="!t.actions?.dismiss" @click="onDismiss(t)">
                                Dismiss
                            </button>
                        </div>
                    </div>
                </div>

                <div v-if="visibleTasks.length === 0" class="p-3 text-sm text-default opacity-80">
                    No tasks.
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { useTaskCenterStore, type TaskRecord } from "../stores/taskCenter";
import type { TaskKind, TaskState } from "../types";
import { storeToRefs } from "pinia";
import { formatBytes } from "../lib/helpers";
const taskCenter = useTaskCenterStore();

const open = ref(false);
const filterKind = ref<TaskKind | null>(null);
const { items } = storeToRefs(taskCenter);
const countsByKind = computed(() => taskCenter.countsByKind);

const badges = computed(() => {
    const order: TaskKind[] = ["download", "upload", "copy", "move", "delete", "rename"];
    return order
        .map((kind) => ({
            kind,
            count: countsByKind.value[kind],
            label: `${kind} tasks`,
            short: shortKind(kind),
            className: kindBadgeClass(kind) + (filterKind.value === kind ? " ring-2 ring-default" : ""),
        }))
        .filter((b) => b.count > 0);
});

const visibleTasks = computed<TaskRecord[]>(() => {
    const base = items.value;
    if (!filterKind.value) return base;
    return base.filter((t) => t.kind === filterKind.value);
});

function toggleFilter(kind: TaskKind) {
    filterKind.value = filterKind.value === kind ? null : kind;
}

function onCancel(t: TaskRecord) {
    taskCenter.cancel(t.id);

}

function onDismiss(t: TaskRecord) {
    taskCenter.dismiss(t.id);

}

function shortKind(k: TaskKind) {
    switch (k) {
        case "download":
            return "Dn";
        case "upload":
            return "Up";
        case "copy":
            return "Cp";
        case "move":
            return "Mv";
        case "delete":
            return "Del";
        case "rename":
            return "Ren";
    }
}

function kindLabel(k: TaskKind) {
    switch (k) {
        case "download":
            return "Download";
        case "upload":
            return "Upload";
        case "copy":
            return "Copy";
        case "move":
            return "Move";
        case "delete":
            return "Delete";
        case "rename":
            return "Rename";
    }
}

function stateLabel(s: TaskState) {
    switch (s) {
        case "running":
            return "Running";
        case "canceling":
            return "Canceling";
        case "done":
            return "Done";
        case "failed":
            return "Failed";
        case "canceled":
            return "Canceled";
    }
}

function kindBadgeClass(kind: TaskKind) {
    switch (kind) {
        case "download":
            return "bg-default";
        case "upload":
            return "bg-default";
        case "copy":
        case "move":
            return "bg-default";
        case "delete":
            return "bg-default";
        case "rename":
            return "bg-default";
    }
}

function pctFor(t: TaskRecord): number | null {
    if (typeof t.progressPct === "number") return Math.max(0, Math.min(100, Math.floor(t.progressPct)));
    if (typeof t.progressCurrent === "number" && typeof t.progressTotal === "number" && t.progressTotal > 0) {
        return Math.max(0, Math.min(100, Math.floor((t.progressCurrent * 100) / t.progressTotal)));
    }
    return null;
}

onBeforeUnmount(() => {
    open.value = false;
});
</script>