import { createRouter, createWebHashHistory, type RouteRecordRaw } from "vue-router";

import EndpointSetup from "./views/EndpointSetup.vue";
import BucketsView from "./views/BucketsView.vue";
import ObjectsView from "./views/ObjectsView.vue";


const routes: RouteRecordRaw[] = [
  { path: "/", name: "Home", component: EndpointSetup },
  { path: "/buckets", name: "Buckets", component: BucketsView },
  { path: "/objects", name: "Objects", component: ObjectsView },

];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});
