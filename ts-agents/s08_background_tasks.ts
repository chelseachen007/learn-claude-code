/**
 * s08_background_tasks.ts - Background Tasks (TypeScript 版本)
 *
 * Run commands in background threads. A notification queue is drained
 * before each LLM call to deliver results.
 *
 *     Main thread                Background thread
 *     +-----------------+        +-----------------+
 *     | agent loop      |        | task executes   |
 *     | ...             |        | ...             |
 *     | [LLM call] <---+------- | enqueue(result) |
 *     |  ^drain queue   |        +-----------------+
 *     +-----------------+
 *
 *     Timeline:
 *     Agent ----[spawn A]----[spawn B]----[other work]----
 *                  |              |
 *                  v              v
 *               [A runs]      [B runs]        (parallel)
 *                  |              |
 *                  +-- notification queue --> [results injected]
 *
 * Key insight: "Fire and forget -- the agent doesn't block while the command runs."
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync, exec } from "child_process";
import { config } from "dotenv";
import * as path from "path";
import * as fs from "fs";
import * as readline from "readline";
import { randomUUID } from "crypto";

// 加载 .env 文件（从父目录）
config({ path: "../.env" });

// ============================================================================
// 配置
// ============================================================================

const MODEL = process.env.MODEL_ID || "claude-sonnet-4-20250514";
const WORKDIR = process.cwd();
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use background_run for long-running commands.`;

// ============================================================================
// 类型定义
// ============================================================================

interface Task {
  status: "running" | "completed" | "timeout" | "error";
  result: string | null;
  command: string;
}

interface Notification {
  task_id: string;
  status: string;
  command: string;
  result: string;
}

// ============================================================================
// BackgroundManager: 线程执行 + 通知队列
// ============================================================================

class BackgroundManager {
  private tasks: Map<string, Task> = new Map();
  private notificationQueue: Notification[] = [];
  private lock: Notification[] = [];

  run(command: string): string {
    const taskId = randomUUID().slice(0, 8);
    this.tasks.set(taskId, {
      status: "running",
      result: null,
      command: command,
    });

    // 使用 child_process 异步执行
    exec(
      command,
      {
        cwd: WORKDIR,
        timeout: 300000, // 300秒
        maxBuffer: 50 * 1024 * 1024, // 50MB
      },
      (error, stdout, stderr) => {
        let output: string;
        let status: "completed" | "timeout" | "error";

        if (error) {
          if ((error as any).killed) {
            output = "Error: Timeout (300s)";
            status = "timeout";
          } else {
            output = `Error: ${error.message}`;
            status = "error";
          }
        } else {
          output = (stdout + stderr).trim().slice(0, 50000) || "(no output)";
          status = "completed";
        }

        const task = this.tasks.get(taskId);
        if (task) {
          task.status = status;
          task.result = output;
        }

        // 添加到通知队列
        this.notificationQueue.push({
          task_id: taskId,
          status: status,
          command: command.slice(0, 80),
          result: output.slice(0, 500),
        });
      }
    );

    return `Background task ${taskId} started: ${command.slice(0, 80)}`;
  }

  check(taskId?: string): string {
    if (taskId) {
      const t = this.tasks.get(taskId);
      if (!t) {
        return `Error: Unknown task ${taskId}`;
      }
      return `[${t.status}] ${t.command.slice(0, 60)}\n${t.result || "(running)"}`;
    }

    const lines: string[] = [];
    for (const [tid, t] of this.tasks) {
      lines.push(`${tid}: [${t.status}] ${t.command.slice(0, 60)}`);
    }
    return lines.length > 0 ? lines.join("\n") : "No background tasks.";
  }

  drainNotifications(): Notification[] {
    const notifs = [...this.notificationQueue];
    this.notificationQueue = [];
    return notifs;
  }
}

const BG = new BackgroundManager();

// ============================================================================
// 工具实现
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
    const stderr = ""; // execSync 不分离 stderr
    const result = (output || "").trim();
    return result.slice(0, 50000) || "(no output)";
  } catch (error: any) {
    if (error.status !== undefined) {
      // 命令执行了但返回非零状态
      const result = (error.stdout || "" + error.stderr || "").trim();
      return result.slice(0, 50000) || `Error: Exit code ${error.status}`;
    }
    return `Error: ${error.message}`;
  }
}

function runRead(filePath: string, limit?: number): string {
  try {
    const fp = safePath(filePath);
    const content = fs.readFileSync(fp, "utf-8");
    let lines = content.split("\n");
    if (limit && limit < lines.length) {
      lines = lines.slice(0, limit);
      lines.push(`... (${lines.length - limit} more)`);
    }
    return lines.join("\n").slice(0, 50000);
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

function runWrite(filePath: string, content: string): string {
  try {
    const fp = safePath(filePath);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content);
    return `Wrote ${content.length} bytes`;
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

function runEdit(filePath: string, oldText: string, newText: string): string {
  try {
    const fp = safePath(filePath);
    const content = fs.readFileSync(fp, "utf-8");
    if (!content.includes(oldText)) {
      return `Error: Text not found in ${filePath}`;
    }
    const newContent = content.replace(oldText, newText);
    fs.writeFileSync(fp, newContent);
    return `Edited ${filePath}`;
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

// ============================================================================
// 工具定义
// ============================================================================

const TOOLS: Anthropic.Tool[] = [
  {
    name: "bash",
    description: "Run a shell command (blocking).",
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
    name: "background_run",
    description: "Run command in background thread. Returns task_id immediately.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
      },
      required: ["command"],
    },
  },
  {
    name: "check_background",
    description: "Check background task status. Omit task_id to list all.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
      },
    },
  },
];

// ============================================================================
// 工具处理器
// ============================================================================

const TOOL_HANDLERS: Record<string, (input: any) => string> = {
  bash: (input) => runBash(input.command),
  read_file: (input) => runRead(input.path, input.limit),
  write_file: (input) => runWrite(input.path, input.content),
  edit_file: (input) => runEdit(input.path, input.old_text, input.new_text),
  background_run: (input) => BG.run(input.command),
  check_background: (input) => BG.check(input.task_id),
};

// ============================================================================
// Agent 循环 - 核心逻辑
// ============================================================================

async function agentLoop(
  client: Anthropic,
  messages: Anthropic.MessageParam[]
): Promise<void> {
  while (true) {
    // 在 LLM 调用之前排空后台通知并注入为系统消息
    const notifs = BG.drainNotifications();
    if (notifs.length > 0 && messages.length > 0) {
      const notifText = notifs
        .map((n) => `[bg:${n.task_id}] ${n.status}: ${n.result}`)
        .join("\n");
      messages.push({
        role: "user",
        content: `<background-results>\n${notifText}\n</background-results>`,
      });
      messages.push({
        role: "assistant",
        content: "Noted background results.",
      });
    }

    // 调用 LLM
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system: SYSTEM,
      messages: messages,
      tools: TOOLS,
    });

    // 将助手回复添加到消息历史
    messages.push({
      role: "assistant",
      content: response.content,
    });

    // 检查是否需要调用工具
    if (response.stop_reason !== "tool_use") {
      return;
    }

    // 执行工具调用
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type === "tool_use") {
        const toolName = block.name;
        const toolInput = block.input;
        const toolId = block.id;

        // 执行工具
        let output: string;
        try {
          output = TOOL_HANDLERS[toolName]?.(toolInput) || `Unknown tool: ${toolName}`;
        } catch (error: any) {
          output = `Error: ${error.message}`;
        }

        // 打印执行的命令
        console.log(`> ${toolName}: ${output.slice(0, 200)}`);

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolId,
          content: output,
        });
      }
    }

    // 将工具结果返回给模型，继续循环
    messages.push({
      role: "user",
      content: toolResults,
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
  console.log("\ns08 Background Tasks (TypeScript)");
  console.log("==================================\n");

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
      query = await askQuestion("\x1b[36ms08 >> \x1b[0m");
    } catch (error) {
      break;
    }

    if (query.trim().toLowerCase() === "q" || query.trim().toLowerCase() === "exit" || query.trim() === "") {
      break;
    }

    history.push({
      role: "user",
      content: query,
    });

    await agentLoop(client, history);

    // 打印响应
    const lastContent = history[history.length - 1].content;
    if (Array.isArray(lastContent)) {
      for (const block of lastContent) {
        if (block.type === "text") {
          console.log((block as Anthropic.TextBlock).text);
        }
      }
    }
    console.log();
  }
}

main().catch(console.error);
