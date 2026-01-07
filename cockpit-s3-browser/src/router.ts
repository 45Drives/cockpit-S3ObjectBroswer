import { createRouter, createWebHashHistory, type RouteRecordRaw } from "vue-router";

import EndpointSetup from "./views/EndpointSetup.vue";
import BucketsView from "./views/BucketsView.vue";

const routes: RouteRecordRaw[] = [
  { path: "/", name: "Home", component: EndpointSetup },
  { path: "/buckets", name: "Buckets", component: BucketsView },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});
