// theme-without-fonts drops VitePress's bundled Inter; fonts are self-hosted below.
import DefaultTheme from "vitepress/theme-without-fonts";
import type { Theme } from "vitepress";
import "@fontsource-variable/atkinson-hyperlegible-next/wght.css";
import "@fontsource-variable/atkinson-hyperlegible-next/wght-italic.css";
import "@fontsource-variable/atkinson-hyperlegible-mono/wght.css";
import BlogIndex from "./BlogIndex.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("BlogIndex", BlogIndex);
  },
} satisfies Theme;
