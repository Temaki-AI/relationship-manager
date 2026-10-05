import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

// Cloud development always uses the isolated local bindings, even when this
// computer is authenticated with Cloudflare. SQLite development needs no proxy.
if (process.env.EVERCLOSE_DEVELOPMENT !== 'local') {
  initOpenNextCloudflareForDev(process.env.EVERCLOSE_DEVELOPMENT === 'cloud' ? {
    configPath: 'wrangler.local.jsonc',
    // getPlatformProxy takes the v3 path; Wrangler --persist-to takes its parent.
    persist: { path: '.wrangler/everclose-local/v3' },
    remoteBindings: false,
  } : undefined);
}

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
  webpack(config, { dev }) {
    // Allow release builds on machines without space for webpack's disk cache.
    if (!dev && process.env.EVERCLOSE_BUILD_CACHE === 'false') config.cache = false;
    return config;
  },
  outputFileTracingExcludes: {
    "/*": ["./data/**/*"],
  },
};

export default nextConfig;
