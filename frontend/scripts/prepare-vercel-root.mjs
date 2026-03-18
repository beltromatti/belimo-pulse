import { cp, rm, stat, symlink } from "node:fs/promises";
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
  const frontendNodeModulesDir = path.join(frontendRoot, "node_modules");
  const repoRootNodeModulesDir = path.resolve(frontendRoot, "..", "node_modules");

  if (!(await pathExists(frontendNextDir))) {
    return;
  }

  await rm(repoRootNextDir, { force: true, recursive: true });
  await cp(frontendNextDir, repoRootNextDir, { recursive: true });
  await rm(repoRootNodeModulesDir, { force: true, recursive: true });
  await symlink(frontendNodeModulesDir, repoRootNodeModulesDir, "dir");

  console.log(`Mirrored ${frontendNextDir} to ${repoRootNextDir} for Vercel post-processing.`);
  console.log(`Linked ${repoRootNodeModulesDir} to ${frontendNodeModulesDir} for Vercel post-processing.`);
}

main().catch((error) => {
  console.error("Failed to mirror .next output for Vercel.", error);
  process.exit(1);
});
