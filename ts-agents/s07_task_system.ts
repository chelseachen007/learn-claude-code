/**
 * s07_task_system.ts - Tasks (TypeScript 版本)
 *
 * Tasks persist as JSON files in .tasks/ so they survive context compression.
 * Each task has a dependency graph (blockedBy/blocks).
 *
 *     .tasks/
 *       task_1.json  {"id":1, "subject":"...", "status":"completed", ...}
 *       task_2.json  {"id":2, "blockedBy":[1], "status":"pending", ...}
 *       task_3.json  {"id":3, "blockedBy":[2], "blocks":[], ...}
 *
 *     Dependency resolution:
 *     +----------+     +----------+     +----------+
 *     | task 1   | --> | task 2   | --> | task 3   |
 *     | complete |     | blocked  |     | blocked  |
 *     +----------+     +----------+     +----------+
 *          |                ^
 *          +--- completing task 1 removes it from task 2's blockedBy
 *
 * Key insight: "State that survives compression -- because it's outside the conversation."
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
const TASKS_DIR = path.join(WORKDIR, ".tasks");

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use task tools to plan and track work.`;

// ============================================================================
// 类型定义
// ============================================================================

type TaskStatus = "pending" | "in_progress" | "completed";

interface Task {
  id: number;
  subject: string;
  description: string;
  status: TaskStatus;
  blockedBy: number[];
  blocks: number[];
  owner: string;
}

// ============================================================================
// TaskManager: CRUD with dependency graph, persisted as JSON files
// ============================================================================

class TaskManager {
  private dir: string;
  private nextId: number;

  constructor(tasksDir: string) {
    this.dir = tasksDir;
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
    this.nextId = this.maxId() + 1;
  }

  private maxId(): number {
    const files = fs.readdirSync(this.dir).filter((f) => f.startsWith("task_") && f.endsWith(".json"));
    const ids = files.map((f) => parseInt(f.replace("task_", "").replace(".json", ""), 10)).filter((id) => !isNaN(id));
    return ids.length > 0 ? Math.max(...ids) : 0;
  }

  private load(taskId: number): Task {
    const filePath = path.join(this.dir, `task_${taskId}.json`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Task ${taskId} not found`);
    }
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  }

  private save(task: Task): void {
    const filePath = path.join(this.dir, `task_${task.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(task, null, 2));
  }

  create(subject: string, description: string = ""): string {
    const task: Task = {
      id: this.nextId,
      subject,
      description,
      status: "pending",
      blockedBy: [],
      blocks: [],
      owner: "",
    };
    this.save(task);
    this.nextId++;
    return JSON.stringify(task, null, 2);
  }

  get(taskId: number): string {
    return JSON.stringify(this.load(taskId), null, 2);
  }

  update(
    taskId: number,
    status?: TaskStatus,
    addBlockedBy?: number[],
    addBlocks?: number[]
  ): string {
    const task = this.load(taskId);

    if (status) {
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Invalid status: ${status}`);
      }
      task.status = status;

      // When a task is completed, remove it from all other tasks' blockedBy
      if (status === "completed") {
        this.clearDependency(taskId);
      }
    }

    if (addBlockedBy && addBlockedBy.length > 0) {
      task.blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])];
    }

    if (addBlocks && addBlocks.length > 0) {
      task.blocks = [...new Set([...task.blocks, ...addBlocks])];

      // Bidirectional: also update the blocked tasks' blockedBy lists
      for (const blockedId of addBlocks) {
        try {
          const blocked = this.load(blockedId);
          if (!blocked.blockedBy.includes(taskId)) {
            blocked.blockedBy.push(taskId);
            this.save(blocked);
          }
        } catch (error) {
          // Ignore if blocked task doesn't exist
        }
      }
    }

    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  private clearDependency(completedId: number): void {
    // Remove completedId from all other tasks' blockedBy lists
    const files = fs.readdirSync(this.dir).filter(
      (f) => f.startsWith("task_") && f.endsWith(".json")
    );

    for (const file of files) {
      const filePath = path.join(this.dir, file);
      const task: Task = JSON.parse(fs.readFileSync(filePath, "utf-8"));

      const index = task.blockedBy.indexOf(completedId);
      if (index !== -1) {
        task.blockedBy.splice(index, 1);
        this.save(task);
      }
    }
  }

  listAll(): string {
    const files = fs.readdirSync(this.dir).filter(
      (f) => f.startsWith("task_") && f.endsWith(".json")
    );

    if (files.length === 0) {
      return "No tasks.";
    }

    const tasks: Task[] = files
      .map((f) => JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf-8")))
      .sort((a, b) => a.id - b.id);

    const statusMarkers: Record<TaskStatus, string> = {
      pending: "[ ]",
      in_progress: "[>]",
      completed: "[x]",
    };

    const lines = tasks.map((t) => {
      const marker = statusMarkers[t.status] || "[?]";
      const blocked = t.blockedBy.length > 0 ? ` (blocked by: ${t.blockedBy.join(", ")})` : "";
      return `${marker} #${t.id}: ${t.subject}${blocked}`;
    });

    return lines.join("\n");
  }
}

// ============================================================================
// 初始化
// ============================================================================

const TASKS = new TaskManager(TASKS_DIR);

// ============================================================================
// 工具定义
// ============================================================================

const TOOLS: Anthropic.Tool[] = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read file contents.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
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
    description: "Create a new task.",
    input_schema: {
      type: "object",
      properties: {
        subject: { type: "string" },
        description: { type: "string" },
      },
      required: ["subject"],
    },
  },
  {
    name: "task_update",
    description: "Update a task's status or dependencies.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "integer" },
        status: { type: "string", enum: ["pending", "in_progress", "completed"] },
        addBlockedBy: { type: "array", items: { type: "integer" } },
        addBlocks: { type: "array", items: { type: "integer" } },
      },
      required: ["task_id"],
    },
  },
  {
    name: "task_list",
    description: "List all tasks with status summary.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "task_get",
    description: "Get full details of a task by ID.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "integer" },
      },
      required: ["task_id"],
    },
  },
];

// ============================================================================
// 工具处理器
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
    });
    const result = (output || "").trim();
    return result.slice(0, 50000) || "(no output)";
  } catch (error: any) {
    const output = (error.stdout || "") + (error.stderr || "");
    return output.trim().slice(0, 50000) || `Error: ${error.message}`;
  }
}

function runRead(filePath: string, limit?: number): string {
  try {
    const safe = safePath(filePath);
    const content = fs.readFileSync(safe, "utf-8");
    const lines = content.split("\n");

    if (limit !== undefined && limit < lines.length) {
      const truncated = lines.slice(0, limit);
      truncated.push(`... (${lines.length - limit} more)`);
      return truncated.join("\n").slice(0, 50000);
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
    fs.writeFileSync(safe, content.replace(oldText, newText));
    return `Edited ${filePath}`;
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

interface ToolInput {
  command?: string;
  path?: string;
  content?: string;
  limit?: number;
  old_text?: string;
  new_text?: string;
  subject?: string;
  description?: string;
  task_id?: number;
  status?: TaskStatus;
  addBlockedBy?: number[];
  addBlocks?: number[];
}

const TOOL_HANDLERS: Record<string, (input: ToolInput) => string> = {
  bash: (input) => runBash(input.command!),
  read_file: (input) => runRead(input.path!, input.limit),
  write_file: (input) => runWrite(input.path!, input.content!),
  edit_file: (input) => runEdit(input.path!, input.old_text!, input.new_text!),
  task_create: (input) => TASKS.create(input.subject!, input.description || ""),
  task_update: (input) =>
    TASKS.update(input.task_id!, input.status, input.addBlockedBy, input.addBlocks),
  task_list: () => TASKS.listAll(),
  task_get: (input) => TASKS.get(input.task_id!),
};

// ============================================================================
// Agent 循环 - 核心逻辑
// ============================================================================

async function agentLoop(
  client: Anthropic,
  messages: Anthropic.MessageParam[]
): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system: SYSTEM,
      messages: messages,
      tools: TOOLS,
    });

    messages.push({
      role: "assistant",
      content: response.content,
    });

    if (response.stop_reason !== "tool_use") {
      return;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = TOOL_HANDLERS[block.name];
        let output: string;

        try {
          output = handler
            ? handler(block.input as ToolInput)
            : `Unknown tool: ${block.name}`;
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

    messages.push({
      role: "user",
      content: results,
    });
  }
}

// ============================================================================
// 交互式输入
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
  console.log("\n🤖 s07 Task System (TypeScript)");
  console.log("================================\n");

  // 初始化客户端
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.ANTHROPIC_BASE_URL,
  });

  const history: Anthropic.MessageParam[] = [];

  // REPL 循环
  while (true) {
    let query: string;
    try {
      query = await askQuestion("\x1b[36ms07 >> \x1b[0m");
    } catch (error) {
      break;
    }

    if (
      query.trim().toLowerCase() === "q" ||
      query.trim().toLowerCase() === "exit" ||
      query.trim() === ""
    ) {
      break;
    }

    history.push({ role: "user", content: query });

    await agentLoop(client, history);

    // 打印最后的响应
    const lastMessage = history[history.length - 1];
    if (lastMessage.role === "assistant") {
      const content = lastMessage.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text") {
            console.log((block as Anthropic.TextBlock).text);
          }
        }
      }
    }
    console.log();
  }
}

main().catch(console.error);
