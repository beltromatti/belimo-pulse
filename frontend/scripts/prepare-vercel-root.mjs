import { cp, rm, stat } from "node:fs/promises";
import path from "node:path";

async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (process.env.VERCEL !== "1") {
    return;
  }

  const frontendRoot = process.cwd();
  const frontendNextDir = path.join(frontendRoot, ".next");
  const repoRootNextDir = path.resolve(frontendRoot, "..", ".next");

  if (!(await pathExists(frontendNextDir))) {
    return;
  }

  await rm(repoRootNextDir, { force: true, recursive: true });
  await cp(frontendNextDir, repoRootNextDir, { recursive: true });

  console.log(`Mirrored ${frontendNextDir} to ${repoRootNextDir} for Vercel post-processing.`);
}

main().catch((error) => {
  console.error("Failed to mirror .next output for Vercel.", error);
  process.exit(1);
});
