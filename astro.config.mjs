import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import sitemap from '@astrojs/sitemap';

// Hybrid mode: static pages + Vercel serverless for /api routes
export default defineConfig({
  site: 'https://coolswamps.com',
  output: 'static',          // All pages are pre-rendered at build time
  integrations: [
    tailwind(),
    sitemap(),
  ],
});
