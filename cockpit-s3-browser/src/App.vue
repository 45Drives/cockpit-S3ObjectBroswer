<template>
  <div class="min-h-screen h-full w-full min-w-fit flex flex-col bg-default overflow-auto">
    <HoustonAppContainer moduleName="cockpit-S3-Browser" :appVersion="version">
      <div class="w-full flex justify-end px-4 pt-3">
        <DeleteTasksDropdown />
        <TaskCenter />
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
import DeleteTasksDropdown from "./components/DeleteTasksDropdown.vue";
import TaskCenter from "./components/TaskCenter.vue";
import TaskProgressController from "./components/TaskProgressController.vue";

const version = __APP_VERSION__;
</script>
