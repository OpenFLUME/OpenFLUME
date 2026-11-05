import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import BlogIndex from "./BlogIndex.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("BlogIndex", BlogIndex);
  },
} satisfies Theme;
