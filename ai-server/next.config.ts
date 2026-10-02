import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Gzip buffers the SSE stream at /api/stream; Railway's edge compresses anyway.
  compress: false,
  poweredByHeader: false,
};

export default nextConfig;
