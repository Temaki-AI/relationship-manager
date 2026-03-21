import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  webpack: (config) => {
    // Fix for better-sqlite3
    config.externals = [...(config.externals || []), 'better-sqlite3'];
    return config;
  },
};

export default nextConfig;
