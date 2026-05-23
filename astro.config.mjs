import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import vercel from '@astrojs/vercel/static';

export default defineConfig({
  site: 'https://coolswamps.com',
  output: 'static',
  adapter: vercel({
    webAnalytics: {
      enabled: true,
    },
  }),
  integrations: [
    tailwind(),
    // sitemap temporarily removed — @astrojs/sitemap 3.1.x incompatible with Astro 6.x
    // re-add once @astrojs/sitemap 3.2+ is confirmed compatible
  ],
});
