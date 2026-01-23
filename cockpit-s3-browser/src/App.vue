<template>
  <div class="min-h-screen h-full w-full min-w-fit flex flex-col bg-default overflow-auto">
    <HoustonAppContainer moduleName="cockpit-S3-Browser" :appVersion="version">
      <!-- Warning banner -->
      <div v-if="hasActive" class="px-4 pt-3">
        <div class="rounded-md border border-yellow-300 bg-default p-3 text-sm text-default">
          <div class="font-semibold">Transfer in progress</div>
          <div class="opacity-80">
            Uploads/downloads are running. Refreshing or closing this tab will cancel them.
          </div>
        </div>
      </div>

      <div class="w-full flex justify-end px-4 pt-3">
      </div>

      <TaskProgressController />
      <router-view />
    </HoustonAppContainer>
  </div>
</template>

<script setup lang="ts">
import "@45drives/houston-common-ui/style.css";
import "@45drives/houston-common-css/src/index.css";

import { HoustonAppContainer } from "@45drives/houston-common-ui";
import TaskProgressController from "./components/TaskProgressController.vue";
import { computed, onBeforeUnmount, onMounted } from "vue";
import { useTaskCenterStore } from "./stores/taskCenter";

const taskCenter = useTaskCenterStore();
const hasActive = computed(() => taskCenter.hasActive);

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (!taskCenter.hasActive) return;
  e.preventDefault();
}

onMounted(() => {
  window.addEventListener("beforeunload", onBeforeUnload);
});

onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", onBeforeUnload);
});

const version = __APP_VERSION__;
</script>
