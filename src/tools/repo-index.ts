import { readdir, stat, writeFile } from "fs/promises";
import { resolve, join } from "path";

interface RepoEntry {
  name: string;
  path: string;
  hasGit: boolean;
}

interface RepoIndex {
  basePath: string;
  generatedAt: string;
  lookupPaths: string[];
  repositories: RepoEntry[];
}

async function main(): Promise<void> {
  const basePath = resolve(process.argv[2] ?? process.env.REPO_BASE_PATH ?? "C:\\Repo");
  const outputPath = resolve(process.argv[3] ?? "configs/repo-index.json");

  const entries = await readdir(basePath, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const repositories: RepoEntry[] = [];

  for (const directoryName of directories) {
    const repoPath = resolve(basePath, directoryName);
    const gitPath = join(repoPath, ".git");

    let hasGit = false;
    try {
      const gitStat = await stat(gitPath);
      hasGit = gitStat.isDirectory() || gitStat.isFile();
    } catch {
      hasGit = false;
    }

    repositories.push({
      name: directoryName,
      path: repoPath,
      hasGit,
    });
  }

  const lookupPaths = repositories
    .filter((repo) => !repo.name.startsWith("."))
    .map((repo) => repo.path);

  const index: RepoIndex = {
    basePath,
    generatedAt: new Date().toISOString(),
    lookupPaths,
    repositories,
  };

  await writeFile(outputPath, JSON.stringify(index, null, 2) + "\n", "utf-8");
  console.log(`Repo index written to ${outputPath}`);
  console.log(`Lookup paths: ${lookupPaths.length}`);
}

main().catch((error) => {
  console.error("Failed to generate repo index:", error);
  process.exit(1);
});
