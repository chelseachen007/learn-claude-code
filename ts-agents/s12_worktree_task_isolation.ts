/**
 * s12_worktree_task_isolation.ts - Worktree + Task Isolation (TypeScript 版本)
 *
 * Directory-level isolation for parallel task execution.
 * Tasks are the control plane and worktrees are the execution plane.
 *
 *     .tasks/task_12.json
 *       {
 *         "id": 12,
 *         "subject": "Implement auth refactor",
 *         "status": "in_progress",
 *         "worktree": "auth-refactor"
 *       }
 *
 *     .worktrees/index.json
 *       {
 *         "worktrees": [
 *           {
 *             "name": "auth-refactor",
 *             "path": ".../.worktrees/auth-refactor",
 *             "branch": "wt/auth-refactor",
 *             "task_id": 12,
 *             "status": "active"
 *           }
 *         ]
 *       }
 *
 * Key insight: "Isolate by directory, coordinate by task ID."
 */

import Anthropic from "@anthropic-ai/sdk";
import * as readline from "readline";
import { execSync } from "child_process";
import { config } from "dotenv";
import * as path from "path";
import * as fs from "fs";

// 加载 .env 文件（从父目录）
config({ path: "../.env" });

// ============================================================================
// 配置
// ============================================================================

const MODEL = process.env.MODEL_ID || "claude-sonnet-4-20250514";
const WORKDIR = process.cwd();

function detectRepoRoot(cwd: string): string | null {
  try {
    const output = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const root = output.trim();
    return fs.existsSync(root) ? root : null;
  } catch {
    return null;
  }
}

const REPO_ROOT = detectRepoRoot(WORKDIR) || WORKDIR;

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use task + worktree tools for multi-task work. For parallel or risky changes: create tasks, allocate worktree lanes, run commands in those lanes, then choose keep/remove for closeout. Use worktree_events when you need lifecycle visibility.`;

// ============================================================================
// 类型定义
// ============================================================================

interface Task {
  id: number;
  subject: string;
  description?: string;
  status: "pending" | "in_progress" | "completed";
  owner?: string;
  worktree?: string;
  blockedBy?: number[];
  created_at?: number;
  updated_at?: number;
}

interface WorktreeEntry {
  name: string;
  path: string;
  branch: string;
  task_id?: number;
  status: "active" | "removed" | "kept";
  created_at?: number;
  removed_at?: number;
  kept_at?: number;
}

interface WorktreeIndex {
  worktrees: WorktreeEntry[];
}

interface EventPayload {
  event: string;
  ts: number;
  task: Partial<Task>;
  worktree: Partial<WorktreeEntry>;
  error?: string;
}

// ============================================================================
// EventBus: append-only lifecycle events for observability
// ============================================================================

class EventBus {
  private path: string;

  constructor(eventLogPath: string) {
    this.path = eventLogPath;
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    if (!fs.existsSync(this.path)) {
      fs.writeFileSync(this.path, "");
    }
  }

  emit(
    event: string,
    task?: Partial<Task>,
    worktree?: Partial<WorktreeEntry>,
    error?: string
  ): void {
    const payload: EventPayload = {
      event,
      ts: Date.now() / 1000,
      task: task || {},
      worktree: worktree || {},
    };
    if (error) {
      payload.error = error;
    }
    fs.appendFileSync(this.path, JSON.stringify(payload) + "\n", "utf-8");
  }

  listRecent(limit: number = 20): string {
    const n = Math.max(1, Math.min(Math.floor(limit || 20), 200));
    const content = fs.readFileSync(this.path, "utf-8");
    const lines = content.split("\n").filter((l) => l);
    const recent = lines.slice(-n);
    const items: any[] = [];
    for (const line of recent) {
      try {
        items.push(JSON.parse(line));
      } catch {
        items.push({ event: "parse_error", raw: line });
      }
    }
    return JSON.stringify(items, null, 2);
  }
}

// ============================================================================
// TaskManager: persistent task board with optional worktree binding
// ============================================================================

class TaskManager {
  private dir: string;
  private nextId: number;

  constructor(tasksDir: string) {
    this.dir = tasksDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.nextId = this.maxId() + 1;
  }

  private maxId(): number {
    const ids: number[] = [];
    const files = fs.readdirSync(this.dir).filter((f) => f.startsWith("task_") && f.endsWith(".json"));
    for (const file of files) {
      const match = file.match(/task_(\d+)\.json/);
      if (match) {
        ids.push(parseInt(match[1], 10));
      }
    }
    return ids.length > 0 ? Math.max(...ids) : 0;
  }

  private taskPath(taskId: number): string {
    return path.join(this.dir, `task_${taskId}.json`);
  }

  private load(taskId: number): Task {
    const taskPath = this.taskPath(taskId);
    if (!fs.existsSync(taskPath)) {
      throw new Error(`Task ${taskId} not found`);
    }
    return JSON.parse(fs.readFileSync(taskPath, "utf-8"));
  }

  private save(task: Task): void {
    fs.writeFileSync(this.taskPath(task.id), JSON.stringify(task, null, 2));
  }

  create(subject: string, description: string = ""): string {
    const task: Task = {
      id: this.nextId,
      subject,
      description,
      status: "pending",
      owner: "",
      worktree: "",
      blockedBy: [],
      created_at: Date.now() / 1000,
      updated_at: Date.now() / 1000,
    };
    this.save(task);
    this.nextId++;
    return JSON.stringify(task, null, 2);
  }

  get(taskId: number): string {
    return JSON.stringify(this.load(taskId), null, 2);
  }

  exists(taskId: number): boolean {
    return fs.existsSync(this.taskPath(taskId));
  }

  update(taskId: number, status?: string, owner?: string): string {
    const task = this.load(taskId);
    if (status) {
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Invalid status: ${status}`);
      }
      task.status = status as Task["status"];
    }
    if (owner !== undefined) {
      task.owner = owner;
    }
    task.updated_at = Date.now() / 1000;
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  bindWorktree(taskId: number, worktree: string, owner: string = ""): string {
    const task = this.load(taskId);
    task.worktree = worktree;
    if (owner) {
      task.owner = owner;
    }
    if (task.status === "pending") {
      task.status = "in_progress";
    }
    task.updated_at = Date.now() / 1000;
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  unbindWorktree(taskId: number): string {
    const task = this.load(taskId);
    task.worktree = "";
    task.updated_at = Date.now() / 1000;
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  listAll(): string {
    const tasks: Task[] = [];
    const files = fs.readdirSync(this.dir).filter((f) => f.startsWith("task_") && f.endsWith(".json")).sort();

    for (const file of files) {
      tasks.push(JSON.parse(fs.readFileSync(path.join(this.dir, file), "utf-8")));
    }

    if (tasks.length === 0) {
      return "No tasks.";
    }

    const lines: string[] = [];
    for (const t of tasks) {
      const marker = { pending: "[ ]", in_progress: "[>]", completed: "[x]" }[t.status] || "[?]";
      const owner = t.owner ? ` owner=${t.owner}` : "";
      const wt = t.worktree ? ` wt=${t.worktree}` : "";
      lines.push(`${marker} #${t.id}: ${t.subject}${owner}${wt}`);
    }
    return lines.join("\n");
  }
}

// ============================================================================
// WorktreeManager: create/list/run/remove git worktrees + lifecycle index
// ============================================================================

class WorktreeManager {
  private repoRoot: string;
  private tasks: TaskManager;
  private events: EventBus;
  private dir: string;
  private indexPath: string;
  private gitAvailable: boolean;

  constructor(repoRoot: string, tasks: TaskManager, events: EventBus) {
    this.repoRoot = repoRoot;
    this.tasks = tasks;
    this.events = events;
    this.dir = path.join(repoRoot, ".worktrees");
    fs.mkdirSync(this.dir, { recursive: true });
    this.indexPath = path.join(this.dir, "index.json");
    if (!fs.existsSync(this.indexPath)) {
      fs.writeFileSync(this.indexPath, JSON.stringify({ worktrees: [] }, null, 2));
    }
    this.gitAvailable = this.isGitRepo();
  }

  private isGitRepo(): boolean {
    try {
      const output = execSync("git rev-parse --is-inside-work-tree", {
        cwd: this.repoRoot,
        encoding: "utf-8",
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return output.trim() === "true";
    } catch {
      return false;
    }
  }

  private runGit(args: string[]): string {
    if (!this.gitAvailable) {
      throw new Error("Not in a git repository. worktree tools require git.");
    }
    try {
      const output = execSync(`git ${args.join(" ")}`, {
        cwd: this.repoRoot,
        encoding: "utf-8",
        timeout: 120000,
        maxBuffer: 50 * 1024 * 1024,
      });
      return (output || "").trim() || "(no output)";
    } catch (error: any) {
      const msg = (error.stdout || "") + (error.stderr || "");
      throw new Error(msg.trim() || `git ${args.join(" ")} failed`);
    }
  }

  private loadIndex(): WorktreeIndex {
    return JSON.parse(fs.readFileSync(this.indexPath, "utf-8"));
  }

  private saveIndex(data: WorktreeIndex): void {
    fs.writeFileSync(this.indexPath, JSON.stringify(data, null, 2));
  }

  private find(name: string): WorktreeEntry | undefined {
    const idx = this.loadIndex();
    return idx.worktrees.find((wt) => wt.name === name);
  }

  private validateName(name: string): void {
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(name || "")) {
      throw new Error("Invalid worktree name. Use 1-40 chars: letters, numbers, ., _, -");
    }
  }

  create(name: string, taskId?: number, baseRef: string = "HEAD"): string {
    this.validateName(name);
    if (this.find(name)) {
      throw new Error(`Worktree '${name}' already exists in index`);
    }
    if (taskId !== undefined && !this.tasks.exists(taskId)) {
      throw new Error(`Task ${taskId} not found`);
    }

    const wtPath = path.join(this.dir, name);
    const branch = `wt/${name}`;

    this.events.emit("worktree.create.before", taskId ? { id: taskId } : {}, {
      name,
      base_ref: baseRef,
    });

    try {
      this.runGit(["worktree", "add", "-b", branch, wtPath, baseRef]);

      const entry: WorktreeEntry = {
        name,
        path: wtPath,
        branch,
        task_id: taskId,
        status: "active",
        created_at: Date.now() / 1000,
      };

      const idx = this.loadIndex();
      idx.worktrees.push(entry);
      this.saveIndex(idx);

      if (taskId !== undefined) {
        this.tasks.bindWorktree(taskId, name);
      }

      this.events.emit(
        "worktree.create.after",
        taskId ? { id: taskId } : {},
        {
          name,
          path: wtPath,
          branch,
          status: "active",
        }
      );

      return JSON.stringify(entry, null, 2);
    } catch (error: any) {
      this.events.emit(
        "worktree.create.failed",
        taskId ? { id: taskId } : {},
        { name, base_ref: baseRef },
        error.message
      );
      throw error;
    }
  }

  listAll(): string {
    const idx = this.loadIndex();
    const wts = idx.worktrees;
    if (wts.length === 0) {
      return "No worktrees in index.";
    }
    const lines: string[] = [];
    for (const wt of wts) {
      const suffix = wt.task_id ? ` task=${wt.task_id}` : "";
      lines.push(
        `[${wt.status || "unknown"}] ${wt.name} -> ${wt.path} (${wt.branch || "-"})${suffix}`
      );
    }
    return lines.join("\n");
  }

  status(name: string): string {
    const wt = this.find(name);
    if (!wt) {
      return `Error: Unknown worktree '${name}'`;
    }
    if (!fs.existsSync(wt.path)) {
      return `Error: Worktree path missing: ${wt.path}`;
    }
    try {
      const output = execSync("git status --short --branch", {
        cwd: wt.path,
        encoding: "utf-8",
        timeout: 60000,
      });
      return (output || "").trim() || "Clean worktree";
    } catch (error: any) {
      return (error.stdout || "") + (error.stderr || "") || "Error getting status";
    }
  }

  run(name: string, command: string): string {
    const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
    if (dangerous.some((d) => command.includes(d))) {
      return "Error: Dangerous command blocked";
    }

    const wt = this.find(name);
    if (!wt) {
      return `Error: Unknown worktree '${name}'`;
    }
    if (!fs.existsSync(wt.path)) {
      return `Error: Worktree path missing: ${wt.path}`;
    }

    try {
      const output = execSync(command, {
        cwd: wt.path,
        encoding: "utf-8",
        timeout: 300000,
        maxBuffer: 50 * 1024 * 1024,
        shell: "/bin/bash",
      });
      const result = (output || "").trim();
      return result.slice(0, 50000) || "(no output)";
    } catch (error: any) {
      const result = (error.stdout || "") + (error.stderr || "");
      return result.trim().slice(0, 50000) || `Error: ${error.message}`;
    }
  }

  remove(name: string, force: boolean = false, completeTask: boolean = false): string {
    const wt = this.find(name);
    if (!wt) {
      return `Error: Unknown worktree '${name}'`;
    }

    this.events.emit(
      "worktree.remove.before",
      wt.task_id ? { id: wt.task_id } : {},
      { name, path: wt.path }
    );

    try {
      const args = ["worktree", "remove"];
      if (force) {
        args.push("--force");
      }
      args.push(wt.path);
      this.runGit(args);

      if (completeTask && wt.task_id !== undefined) {
        const taskId = wt.task_id;
        const before = JSON.parse(this.tasks.get(taskId));
        this.tasks.update(taskId, "completed");
        this.tasks.unbindWorktree(taskId);
        this.events.emit(
          "task.completed",
          {
            id: taskId,
            subject: before.subject || "",
            status: "completed",
          },
          { name }
        );
      }

      const idx = this.loadIndex();
      for (const item of idx.worktrees) {
        if (item.name === name) {
          item.status = "removed";
          item.removed_at = Date.now() / 1000;
        }
      }
      this.saveIndex(idx);

      this.events.emit(
        "worktree.remove.after",
        wt.task_id ? { id: wt.task_id } : {},
        { name, path: wt.path, status: "removed" }
      );

      return `Removed worktree '${name}'`;
    } catch (error: any) {
      this.events.emit(
        "worktree.remove.failed",
        wt.task_id ? { id: wt.task_id } : {},
        { name, path: wt.path },
        error.message
      );
      throw error;
    }
  }

  keep(name: string): string {
    const wt = this.find(name);
    if (!wt) {
      return `Error: Unknown worktree '${name}'`;
    }

    const idx = this.loadIndex();
    let kept: WorktreeEntry | undefined;
    for (const item of idx.worktrees) {
      if (item.name === name) {
        item.status = "kept";
        item.kept_at = Date.now() / 1000;
        kept = item;
      }
    }
    this.saveIndex(idx);

    this.events.emit(
      "worktree.keep",
      wt.task_id ? { id: wt.task_id } : {},
      { name, path: wt.path, status: "kept" }
    );

    return kept ? JSON.stringify(kept, null, 2) : `Error: Unknown worktree '${name}'`;
  }
}

// ============================================================================
// Base tools
// ============================================================================

function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }
  try {
    const output = execSync(command, {
      cwd: WORKDIR,
      encoding: "utf-8",
      timeout: 120000,
      maxBuffer: 50 * 1024 * 1024,
      shell: "/bin/bash",
    });
    const result = (output || "").trim();
    return result.slice(0, 50000) || "(no output)";
  } catch (error: any) {
    const result = (error.stdout || "") + (error.stderr || "");
    return result.trim().slice(0, 50000) || `Error: ${error.message}`;
  }
}

function runRead(filePath: string, limit?: number): string {
  try {
    const safe = safePath(filePath);
    const content = fs.readFileSync(safe, "utf-8");
    const lines = content.split("\n");
    if (limit && limit < lines.length) {
      return lines.slice(0, limit).join("\n") + `\n... (${lines.length - limit} more)`;
    }
    return content.slice(0, 50000);
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

function runWrite(filePath: string, content: string): string {
  try {
    const safe = safePath(filePath);
    fs.mkdirSync(path.dirname(safe), { recursive: true });
    fs.writeFileSync(safe, content);
    return `Wrote ${content.length} bytes`;
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

function runEdit(filePath: string, oldText: string, newText: string): string {
  try {
    const safe = safePath(filePath);
    const content = fs.readFileSync(safe, "utf-8");
    if (!content.includes(oldText)) {
      return `Error: Text not found in ${filePath}`;
    }
    fs.writeFileSync(safe, content.replace(oldText, newText, 1));
    return `Edited ${filePath}`;
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

// ============================================================================
// 全局实例
// ============================================================================

const TASKS = new TaskManager(path.join(REPO_ROOT, ".tasks"));
const EVENTS = new EventBus(path.join(REPO_ROOT, ".worktrees", "events.jsonl"));
const WORKTREES = new WorktreeManager(REPO_ROOT, TASKS, EVENTS);

// ============================================================================
// Tool handlers
// ============================================================================

const TOOL_HANDLERS: Record<string, (args: Record<string, any>) => string> = {
  bash: (args) => runBash(args.command),
  read_file: (args) => runRead(args.path, args.limit),
  write_file: (args) => runWrite(args.path, args.content),
  edit_file: (args) => runEdit(args.path, args.old_text, args.new_text),
  task_create: (args) => TASKS.create(args.subject, args.description || ""),
  task_list: () => TASKS.listAll(),
  task_get: (args) => TASKS.get(args.task_id),
  task_update: (args) => TASKS.update(args.task_id, args.status, args.owner),
  task_bind_worktree: (args) => TASKS.bindWorktree(args.task_id, args.worktree, args.owner || ""),
  worktree_create: (args) => {
    try {
      return WORKTREES.create(args.name, args.task_id, args.base_ref || "HEAD");
    } catch (error: any) {
      return `Error: ${error.message}`;
    }
  },
  worktree_list: () => WORKTREES.listAll(),
  worktree_status: (args) => WORKTREES.status(args.name),
  worktree_run: (args) => WORKTREES.run(args.name, args.command),
  worktree_keep: (args) => WORKTREES.keep(args.name),
  worktree_remove: (args) => {
    try {
      return WORKTREES.remove(args.name, args.force || false, args.complete_task || false);
    } catch (error: any) {
      return `Error: ${error.message}`;
    }
  },
  worktree_events: (args) => EVENTS.listRecent(args.limit || 20),
};

// ============================================================================
// Tools definition
// ============================================================================

const TOOLS: Anthropic.Tool[] = [
  {
    name: "bash",
    description: "Run a shell command in the current workspace (blocking).",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read file contents.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "integer" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to file.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace exact text in file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "task_create",
    description: "Create a new task on the shared task board.",
    input_schema: {
      type: "object",
      properties: { subject: { type: "string" }, description: { type: "string" } },
      required: ["subject"],
    },
  },
  {
    name: "task_list",
    description: "List all tasks with status, owner, and worktree binding.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "task_get",
    description: "Get task details by ID.",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "integer" } },
      required: ["task_id"],
    },
  },
  {
    name: "task_update",
    description: "Update task status or owner.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "integer" },
        status: { type: "string", enum: ["pending", "in_progress", "completed"] },
        owner: { type: "string" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "task_bind_worktree",
    description: "Bind a task to a worktree name.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "integer" },
        worktree: { type: "string" },
        owner: { type: "string" },
      },
      required: ["task_id", "worktree"],
    },
  },
  {
    name: "worktree_create",
    description: "Create a git worktree and optionally bind it to a task.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        task_id: { type: "integer" },
        base_ref: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "worktree_list",
    description: "List worktrees tracked in .worktrees/index.json.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "worktree_status",
    description: "Show git status for one worktree.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "worktree_run",
    description: "Run a shell command in a named worktree directory.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" }, command: { type: "string" } },
      required: ["name", "command"],
    },
  },
  {
    name: "worktree_remove",
    description: "Remove a worktree and optionally mark its bound task completed.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        force: { type: "boolean" },
        complete_task: { type: "boolean" },
      },
      required: ["name"],
    },
  },
  {
    name: "worktree_keep",
    description: "Mark a worktree as kept in lifecycle state without removing it.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "worktree_events",
    description: "List recent worktree/task lifecycle events from .worktrees/events.jsonl.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "integer" } },
    },
  },
];

// ============================================================================
// Agent Loop
// ============================================================================

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: TOOLS,
      max_tokens: 8000,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      return;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = TOOL_HANDLERS[block.name];
        let output: string;
        try {
          output = handler ? handler(block.input as Record<string, any>) : `Unknown tool: ${block.name}`;
        } catch (error: any) {
          output = `Error: ${error.message}`;
        }
        console.log(`> ${block.name}: ${output.slice(0, 200)}`);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
      }
    }

    messages.push({ role: "user", content: results });
  }
}

// ============================================================================
// REPL
// ============================================================================

function askQuestion(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// ============================================================================
// 主函数
// ============================================================================

async function main() {
  console.log(`\n🤖 s12 Worktree Task Isolation (TypeScript)`);
  console.log(`============================================`);
  console.log(`Repo root: ${REPO_ROOT}`);

  if (!WORKTREES["gitAvailable"]) {
    console.log("Note: Not in a git repo. worktree_* tools will return errors.");
  }
  console.log();

  const history: Anthropic.MessageParam[] = [];

  while (true) {
    try {
      const query = await askQuestion("\x1b[36ms12 >> \x1b[0m");

      if (query.trim().toLowerCase() === "q" || query.trim().toLowerCase() === "exit" || query.trim() === "") {
        break;
      }

      history.push({ role: "user", content: query });
      await agentLoop(history);

      // Print response
      const lastContent = history[history.length - 1]?.content;
      if (Array.isArray(lastContent)) {
        for (const block of lastContent) {
          if ("text" in block) {
            console.log(block.text);
          }
        }
      }
      console.log();
    } catch (error: any) {
      if (error.message?.includes("EOF") || error.message?.includes("Interrupt")) {
        break;
      }
      console.error("错误:", error.message);
    }
  }
}

main();
