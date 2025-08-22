import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Enable URL imports for Cesium workers/assets if needed in future
  },
  async rewrites() {
    return [
      {
        source: "/cesium/:path*",
        destination: "/_next/static/cesium/:path*",
      },
    ];
  },
};

export default nextConfig;
