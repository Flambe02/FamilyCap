import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { NextConfig } from "next";

function readGitHead(dir: string): string | null {
  const gitDir = join(dir, ".git");
  const headPath = join(gitDir, "HEAD");

  if (!existsSync(headPath)) return null;

  try {
    const head = readFileSync(headPath, "utf8").trim();
    if (head.startsWith("ref: ")) {
      const refPath = join(gitDir, head.slice(5));
      if (existsSync(refPath)) {
        return readFileSync(refPath, "utf8").trim().slice(0, 7);
      }
      return null;
    }

    return head.slice(0, 7);
  } catch {
    return null;
  }
}

function getCommitVersion() {
  const vercelCommit = process.env.VERCEL_GIT_COMMIT_SHA;
  if (vercelCommit) return vercelCommit.slice(0, 7);

  const localCommit = readGitHead(process.cwd());
  return localCommit ?? "local";
}

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: getCommitVersion(),
  },
};

export default nextConfig;