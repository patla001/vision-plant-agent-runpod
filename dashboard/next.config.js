// Load environment variables from the repo-root .env file.
// Next.js by default only looks in the directory where it's running from
// (here: dashboard/). The repo's single source of truth is at the parent
// level, so API routes (e.g. /api/pipeline/abort) need RUNPOD_API_KEY etc.
// from there.
//
// @next/env is already a transitive dependency of next, so this requires
// no additional install.
const path = require("path");
const { loadEnvConfig } = require("@next/env");
loadEnvConfig(path.resolve(__dirname, ".."));

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    unoptimized: true,
  },
};

module.exports = nextConfig;
