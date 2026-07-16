import { execSync } from "node:child_process";
import type { NextConfig } from "next";

function getCommitVersion() {
  const vercelCommit = process.env.VERCEL_GIT_COMMIT_SHA;
  if (vercelCommit) return vercelCommit.slice(0, 7);
  try {
    return execSync("git rev-parse --short=7 HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "local";
  }
}

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: getCommitVersion(),
  },
};

export default nextConfig;