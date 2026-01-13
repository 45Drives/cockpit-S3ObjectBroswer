import { createApp} from 'vue';
import App from './App.vue';
import '@45drives/houston-common-css/src/index.css';
 import "@45drives/houston-common-ui/style.css";
//import '../../houston-common/houston-common-ui/dist/style.css';
import { router } from "./router";
import { createPinia } from 'pinia';


createApp(App).use(createPinia()).use(router).mount("#app");
