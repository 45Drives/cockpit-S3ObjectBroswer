import { createApp } from "vue";
import App from "./App.vue";
import { router } from "./router";
import { createPinia } from "pinia";
import VueProgressBar from "@aacassandra/vue3-progressbar";

const app = createApp(App);

const pinia = createPinia();

app.use(pinia);
app.use(router);

app.use(VueProgressBar, {
  color: "currentColor",
  failedColor: "currentColor",
  thickness: "3px",
  transition: {
    speed: "0.2s",
    opacity: "0.6s",
    termination: 300,
  },
  autoRevert: true,
  location: "top",
  inverse: false,
});

app.mount("#app");
