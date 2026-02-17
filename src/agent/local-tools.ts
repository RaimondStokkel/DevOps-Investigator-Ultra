import { readFile, writeFile, readdir, stat } from "fs/promises";
import { join, resolve, relative } from "path";
import { execSync } from "child_process";
import { glob } from "fs/promises";
import { existsSync } from "fs";
import type { FunctionDefinition } from "./azure-openai-client.js";

/**
 * Local file tools for operating on C:\Repo\ (or configured base path).
 * These run directly in-process, no MCP needed.
 */
export class LocalTools {
  private roots: string[];
  private repoIndexPath?: string;

  constructor(private basePath: string, lookupPaths?: string[], repoIndexPath?: string) {
    this.basePath = resolve(basePath);
    this.roots = Array.from(new Set((lookupPaths ?? [basePath]).map((p) => resolve(p))));
    this.repoIndexPath = repoIndexPath ? resolve(repoIndexPath) : undefined;
  }

  getToolDefinitions(): FunctionDefinition[] {
    return [
      {
        type: "function",
        function: {
          name: "local_read_file",
          description: "Read the contents of a file from the local repository. Path is relative to the repo base path or absolute.",
          parameters: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "File path (relative to repo base or absolute)",
              },
              startLine: {
                type: "number",
                description: "Start reading from this line (1-based, optional)",
              },
              endLine: {
                type: "number",
                description: "Stop reading at this line (1-based, optional)",
              },
            },
            required: ["path"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "local_edit_file",
          description: "Edit a file by replacing a specific string with another. The old_string must exist exactly in the file.",
          parameters: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "File path (relative to repo base or absolute)",
              },
              old_string: {
                type: "string",
                description: "The exact string to find and replace",
              },
              new_string: {
                type: "string",
                description: "The replacement string",
              },
            },
            required: ["path", "old_string", "new_string"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "local_search_files",
          description: "Search for files matching a glob pattern in the local repository. Returns file paths.",
          parameters: {
            type: "object",
            properties: {
              pattern: {
                type: "string",
                description: "Glob pattern (e.g. '**/*.al', 'ERP AL/extensions/**/app.json')",
              },
              directory: {
                type: "string",
                description: "Directory to search in (relative to repo base, optional)",
              },
            },
            required: ["pattern"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "local_grep",
          description: "Search file contents for a regex pattern. Returns matching lines with file paths and line numbers.",
          parameters: {
            type: "object",
            properties: {
              pattern: {
                type: "string",
                description: "Regex pattern to search for",
              },
              directory: {
                type: "string",
                description: "Directory to search in (relative to repo base, optional)",
              },
              filePattern: {
                type: "string",
                description: "File glob pattern to filter (e.g. '*.al', '*.ps1')",
              },
              maxResults: {
                type: "number",
                description: "Maximum number of matches to return (default: 50)",
              },
            },
            required: ["pattern"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "local_get_repo_index",
          description: "Get the configured repository index file content and lookup roots used for local code search.",
          parameters: {
            type: "object",
            properties: {},
            required: [],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "local_list_directory",
          description: "List the contents of a directory in the local repository.",
          parameters: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "Directory path (relative to repo base or absolute)",
              },
            },
            required: ["path"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "local_run_command",
          description: "Execute a shell command in the local repository. Use for git operations, build checks, etc.",
          parameters: {
            type: "object",
            properties: {
              command: {
                type: "string",
                description: "The shell command to execute",
              },
              cwd: {
                type: "string",
                description: "Working directory (relative to repo base, optional)",
              },
            },
            required: ["command"],
          },
        },
      },
    ];
  }

  private resolvePath(filePath: string): string {
    if (filePath.includes(":") || filePath.startsWith("/") || filePath.startsWith("\\")) {
      return resolve(filePath);
    }

    for (const root of this.roots) {
      const candidate = resolve(root, filePath);
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    return resolve(this.basePath, filePath);
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case "local_read_file":
        return this.readFile(args as { path: string; startLine?: number; endLine?: number });
      case "local_edit_file":
        return this.editFile(args as { path: string; old_string: string; new_string: string });
      case "local_search_files":
        return this.searchFiles(args as { pattern: string; directory?: string });
      case "local_grep":
        return this.grepContent(args as { pattern: string; directory?: string; filePattern?: string; maxResults?: number });
      case "local_get_repo_index":
        return this.getRepoIndex();
      case "local_list_directory":
        return this.listDirectory(args as { path: string });
      case "local_run_command":
        return this.runCommand(args as { command: string; cwd?: string });
      default:
        throw new Error(`Unknown local tool: ${name}`);
    }
  }

  private async getRepoIndex(): Promise<string> {
    const candidates = [
      this.repoIndexPath,
      resolve(process.cwd(), "configs", "repo-index.json"),
      resolve(this.basePath, "configs", "repo-index.json"),
    ].filter((p): p is string => Boolean(p));

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        const content = await readFile(candidate, "utf-8");
        return JSON.stringify(
          {
            path: candidate,
            roots: this.roots,
            content: JSON.parse(content),
          },
          null,
          2
        );
      }
    }

    return JSON.stringify(
      {
        path: null,
        roots: this.roots,
        error: "repo-index.json not found",
      },
      null,
      2
    );
  }

  private async readFile(args: { path: string; startLine?: number; endLine?: number }): Promise<string> {
    const fullPath = this.resolvePath(args.path);
    const content = await readFile(fullPath, "utf-8");

    if (args.startLine || args.endLine) {
      const lines = content.split("\n");
      const start = (args.startLine ?? 1) - 1;
      const end = args.endLine ?? lines.length;
      return lines.slice(start, end).join("\n");
    }

    return content;
  }

  private async editFile(args: { path: string; old_string: string; new_string: string }): Promise<string> {
    const fullPath = this.resolvePath(args.path);
    const content = await readFile(fullPath, "utf-8");

    if (!content.includes(args.old_string)) {
      throw new Error(`Could not find the specified string in ${args.path}`);
    }

    const newContent = content.replace(args.old_string, args.new_string);
    await writeFile(fullPath, newContent, "utf-8");

    return `Successfully edited ${args.path}. Replaced ${args.old_string.length} chars with ${args.new_string.length} chars.`;
  }

  private async searchFiles(args: { pattern: string; directory?: string }): Promise<string> {
    const searchDirs = args.directory ? [this.resolvePath(args.directory)] : this.roots;

    const results: string[] = [];
    for (const searchDir of searchDirs) {
      if (results.length >= 200) break;
      await this.walkDir(searchDir, args.pattern, results, 200);
    }

    const uniqueResults = Array.from(new Set(results));

    return uniqueResults.length > 0
      ? `Found ${uniqueResults.length} files:\n${uniqueResults.map((f) => relative(this.basePath, f)).join("\n")}`
      : "No files found matching pattern.";
  }

  private async walkDir(dir: string, pattern: string, results: string[], maxResults: number): Promise<void> {
    if (results.length >= maxResults) return;

    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxResults) break;
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          // Skip common non-relevant directories
          if ([".git", "node_modules", ".alpackages", "dist", ".vs"].includes(entry.name)) continue;
          await this.walkDir(fullPath, pattern, results, maxResults);
        } else if (entry.isFile()) {
          if (this.matchesGlob(entry.name, pattern) || this.matchesGlob(relative(this.basePath, fullPath), pattern)) {
            results.push(fullPath);
          }
        }
      }
    } catch {
      // Permission error or similar, skip
    }
  }

  private matchesGlob(name: string, pattern: string): boolean {
    // Simple glob matching: * matches anything except /, ** matches anything
    const regexStr = pattern
      .replace(/\\/g, "/")
      .replace(/\*\*/g, "§§")
      .replace(/\*/g, "[^/]*")
      .replace(/§§/g, ".*")
      .replace(/\?/g, ".");
    try {
      return new RegExp(`^${regexStr}$`, "i").test(name.replace(/\\/g, "/"));
    } catch {
      return name.includes(pattern.replace(/\*/g, ""));
    }
  }

  private async grepContent(args: {
    pattern: string;
    directory?: string;
    filePattern?: string;
    maxResults?: number;
  }): Promise<string> {
    const searchDirs = args.directory ? [this.resolvePath(args.directory)] : this.roots;
    const maxResults = args.maxResults ?? 50;

    const allMatches: string[] = [];
    for (const searchDir of searchDirs) {
      if (allMatches.length >= maxResults) break;
      const remaining = maxResults - allMatches.length;
      const output = this.runGrep(searchDir, args.pattern, args.filePattern, remaining);
      if (output) {
        allMatches.push(...output.split("\n").filter((line) => line.trim().length > 0));
      }
    }

    const uniqueMatches = Array.from(new Set(allMatches)).slice(0, maxResults);
    return uniqueMatches.length > 0 ? uniqueMatches.join("\n") : "No matches found.";
  }

  private runGrep(
    searchDir: string,
    pattern: string,
    filePattern: string | undefined,
    maxResults: number
  ): string {
    const fileFilter = filePattern
      ? `-Include "${filePattern}"`
      : '-Include "*.al","*.ps1","*.yml","*.json","*.ts","*.js"';
    const cmd = `powershell -Command "Get-ChildItem -Path '${searchDir}' -Recurse ${fileFilter} -File | Select-String -Pattern '${pattern.replace(/'/g, "''")}' -List | Select-Object -First ${maxResults} | ForEach-Object { $_.Path + ':' + $_.LineNumber + ':' + $_.Line.Trim() }"`;

    try {
      const result = execSync(cmd, {
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30_000,
      });
      return result.trim();
    } catch (err: unknown) {
      const error = err as { stdout?: string };
      return (error.stdout ?? "").trim();
    }
  }

  private async listDirectory(args: { path: string }): Promise<string> {
    const fullPath = this.resolvePath(args.path);
    const entries = await readdir(fullPath, { withFileTypes: true });

    const items = entries.map((e) => ({
      name: e.name,
      type: e.isDirectory() ? "dir" : "file",
    }));

    return JSON.stringify(items, null, 2);
  }

  private runCommand(args: { command: string; cwd?: string }): string {
    const cwd = args.cwd ? this.resolvePath(args.cwd) : this.basePath;

    try {
      const result = execSync(args.command, {
        encoding: "utf-8",
        cwd,
        maxBuffer: 5 * 1024 * 1024,
        timeout: 60_000,
      });
      return result;
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string; message?: string };
      return `Command failed:\nstdout: ${error.stdout ?? ""}\nstderr: ${error.stderr ?? ""}\n${error.message}`;
    }
  }
}
