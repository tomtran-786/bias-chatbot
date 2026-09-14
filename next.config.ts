import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The protocol document is read from disk at runtime with `process.cwd()`,
  // which Next's file tracing cannot follow. Without this the file is missing
  // from the serverless bundle and every deployed session fails to start.
  outputFileTracingIncludes: {
    "/api/**": ["./protocols/**"],
  },
};

export default nextConfig;
