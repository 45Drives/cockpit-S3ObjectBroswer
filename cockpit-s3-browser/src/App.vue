<template>
  <div class="min-h-screen h-full w-full min-w-fit flex flex-col bg-default overflow-auto">
    <HoustonAppContainer moduleName="cockpit-S3-Browser" :appVersion="version">
      <router-view />
    </HoustonAppContainer>
  </div>
</template>

<script setup lang="ts">
import "@45drives/houston-common-ui/style.css";
import "@45drives/houston-common-css/src/index.css";

import { HoustonAppContainer } from "@45drives/houston-common-ui";
const version = __APP_VERSION__;
</script>
