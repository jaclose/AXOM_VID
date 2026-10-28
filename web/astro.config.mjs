import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";
import { fileURLToPath } from "node:url";

// GitHub Pages serves project sites under a subpath like `https://jaclose.github.io/AXOM_VID/`.
// Astro needs to know that subpath so it can prepend it to every internal link and asset URL.
// In local dev we want the root path so things work at `http://localhost:4321/`.
const isProd = process.env.NODE_ENV === "production";

export default defineConfig({
  site: "https://jaclose.github.io",
  base: isProd ? "/AXOM_VID" : "/",
  integrations: [tailwind({
    // We use Tailwind's @tailwind directives inside our own CSS file rather than
    // letting the integration inject a default stylesheet. That gives us control
    // over the order custom CSS and Tailwind utilities are loaded in.
    applyBaseStyles: false,
  })],
  vite: {
    // tsconfig's "paths" entry is read by the TypeScript checker but NOT by Vite,
    // which is what actually resolves imports at dev/build time. We have to repeat
    // the alias here so `@/foo` works inside frontmatter, scripts, and component
    // tags alike. Otherwise script blocks fail with cryptic esbuild errors.
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
  },
});
