<template></template>

<script setup lang="ts">
import { getCurrentInstance, watch, computed } from "vue";
import { useTaskCenterStore } from "../stores/taskCenter";

const taskCenter = useTaskCenterStore();

const inst = getCurrentInstance();

const progress = computed(() => {
  const app = inst?.appContext.app;
  return (app?.config.globalProperties as any)?.$Progress;
});

watch(
  () => [taskCenter.hasActive, taskCenter.overallPct] as const,
  ([hasActive, pct]) => {
    const p = progress.value;
    if (!p) return;

    if (hasActive) {
      p.start();

      if (typeof pct === "number" && Number.isFinite(pct)) {
        p.set(Math.max(0, Math.min(1, pct / 100)));
      }
    } else {
      p.finish();
    }
  },
  { immediate: true },
);

watch(
  () => [taskCenter.hasActive, taskCenter.overallPct] as const,
  (v) => console.log("task progress", v),
  { immediate: true },
);

</script>
