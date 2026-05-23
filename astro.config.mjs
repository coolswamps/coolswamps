import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  site: 'https://coolswamps.com',
  output: 'static',
  integrations: [
    tailwind(),
    // sitemap temporarily removed — @astrojs/sitemap 3.1.x incompatible with Astro 6.x
    // re-add once @astrojs/sitemap 3.2+ is confirmed compatible
  ],
});
