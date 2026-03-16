const nextConfig = {
  output: 'standalone',
  images: {
    unoptimized: true,
  },
  experimental: {
    // Keep DB driver external to server component bundling.
    serverComponentsExternalPackages: ['pg'],
  },
  webpack(config, { dev }) {
    // OneDrive can race with .next filesystem cache and cause missing vendor-chunks warnings.
    // Disable webpack fs cache in dev for stability.
    if (dev) {
      config.cache = false;
    }
    return config;
  },
  // Keep dev chunks/pages warm much longer; helps avoid ChunkLoadError after idle periods.
  onDemandEntries: {
    maxInactiveAge: 60 * 60 * 1000, // 1 hour
    pagesBufferLength: 100, // retain more entries to reduce eviction churn
  },
  async headers() {
    // In development, let Next manage dev asset/runtime headers untouched.
    if (process.env.NODE_ENV !== "production") {
      return [];
    }

    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "ALLOWALL" },
          { key: "Content-Security-Policy", value: "frame-ancestors *;" },
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET, POST, PUT, DELETE, OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "*" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;

