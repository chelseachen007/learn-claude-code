/**
 * s03_todo_write.ts - TodoWrite (TypeScript 版本)
 *
 * 格言: "The agent can track its own progress -- and I can see it."
 *
 * 模型通过 TodoManager 跟踪自己的进度。一个 nag reminder
 * 会在模型忘记更新时强制它更新。
 *
 *     +----------+      +-------+      +---------+
 *     |   User   | ---> |  LLM  | ---> | Tools   |
 *     |  prompt  |      |       |      | + todo  |
 *     +----------+      +---+---+      +----+----+
 *                           ^               |
 *                           |   tool_result |
 *                           +---------------+
 *                                 |
 *                     +-----------+-----------+
 *                     | TodoManager state     |
 *                     | [ ] task A            |
 *                     | [>] task B <- doing   |
 *                     | [x] task C            |
 *                     +-----------------------+
 *                                 |
 *                     if rounds_since_todo >= 3:
 *                       inject <reminder>
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

const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use the todo tool to plan multi-step tasks. Mark in_progress before starting, completed when done.
Prefer tools over prose.`;

// ============================================================================
// TodoManager: LLM 写入的结构化状态
// ============================================================================

type TodoStatus = "pending" | "in_progress" | "completed";

interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
}

class TodoManager {
  private items: TodoItem[] = [];

  update(items: any[]): string {
    if (items.length > 20) {
      throw new Error("Max 20 todos allowed");
    }

    const validated: TodoItem[] = [];
    let inProgressCount = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const text = String(item?.text || "").trim();
      const status = String(item?.status || "pending").toLowerCase() as TodoStatus;
      const itemId = String(item?.id || String(i + 1));

      if (!text) {
        throw new Error(`Item ${itemId}: text required`);
      }

      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Item ${itemId}: invalid status '${status}'`);
      }

      if (status === "in_progress") {
        inProgressCount++;
      }

      validated.push({ id: itemId, text, status });
    }

    if (inProgressCount > 1) {
      throw new Error("Only one task can be in_progress at a time");
    }

    this.items = validated;
    return this.render();
  }

  render(): string {
    if (this.items.length === 0) {
      return "No todos.";
    }

    const lines: string[] = [];
    const markers: Record<TodoStatus, string> = {
      pending: "[ ]",
      in_progress: "[>]",
      completed: "[x]",
    };

    for (const item of this.items) {
      const marker = markers[item.status];
      lines.push(`${marker} #${item.id}: ${item.text}`);
    }

    const done = this.items.filter((t) => t.status === "completed").length;
    lines.push(`\n(${done}/${this.items.length} completed)`);

    return lines.join("\n");
  }
}

const TODO = new TodoManager();

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
        command: {
          type: "string",
        },
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
        path: {
          type: "string",
        },
        limit: {
          type: "integer",
        },
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
        path: {
          type: "string",
        },
        content: {
          type: "string",
        },
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
        path: {
          type: "string",
        },
        old_text: {
          type: "string",
        },
        new_text: {
          type: "string",
        },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "todo",
    description: "Update task list. Track progress on multi-step tasks.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
              text: {
                type: "string",
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
              },
            },
            required: ["id", "text", "status"],
          },
        },
      },
      required: ["items"],
    },
  },
];

// ============================================================================
// 工具处理器
// ============================================================================

function safePath(p: string): string {
  const resolvedPath = path.resolve(WORKDIR, p);
  const relativePath = path.relative(WORKDIR, resolvedPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolvedPath;
}

function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }
  try {
    const output = execSync(command, {
      encoding: "utf-8",
      timeout: 120000, // 120s
      maxBuffer: 50 * 1024 * 1024, // 50MB
      cwd: WORKDIR,
    });
    const result = (output || "").trim();
    return result.slice(0, 50000) || "(no output)";
  } catch (error: any) {
    const stderr = error.stderr || "";
    const stdout = error.stdout || "";
    const result = (stdout + stderr).trim();
    return result.slice(0, 50000) || `Error: ${error.message}`;
  }
}

function runRead(p: string, limit?: number): string {
  try {
    const filePath = safePath(p);
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    if (limit !== undefined && limit < lines.length) {
      lines.splice(limit, lines.length - limit, `... (${lines.length - limit} more lines)`);
    }
    return lines.join("\n").slice(0, 50000);
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

function runWrite(p: string, content: string): string {
  try {
    const filePath = safePath(p);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content, "utf-8");
    return `Wrote ${content.length} bytes to ${p}`;
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

function runEdit(p: string, oldText: string, newText: string): string {
  try {
    const filePath = safePath(p);
    const content = fs.readFileSync(filePath, "utf-8");
    if (!content.includes(oldText)) {
      return `Error: Text not found in ${p}`;
    }
    const newContent = content.replace(oldText, newText);
    fs.writeFileSync(filePath, newContent, "utf-8");
    return `Edited ${p}`;
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

const TOOL_HANDLERS: Record<string, (input: any) => string> = {
  bash: (input) => runBash(input.command),
  read_file: (input) => runRead(input.path, input.limit),
  write_file: (input) => runWrite(input.path, input.content),
  edit_file: (input) => runEdit(input.path, input.old_text, input.new_text),
  todo: (input) => TODO.update(input.items),
};

// ============================================================================
// Agent 循环 - 带 nag reminder 注入
// ============================================================================

async function agentLoop(
  client: Anthropic,
  messages: Anthropic.MessageParam[]
): Promise<void> {
  let roundsSinceTodo = 0;

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

    const results: (Anthropic.ToolResultBlockParam | Anthropic.TextBlockParam)[] = [];
    let usedTodo = false;

    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = TOOL_HANDLERS[block.name];
        let output: string;
        try {
          output = handler ? handler(block.input) : `Unknown tool: ${block.name}`;
        } catch (error: any) {
          output = `Error: ${error.message}`;
        }
        console.log(`> ${block.name}: ${output.slice(0, 200)}`);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
        if (block.name === "todo") {
          usedTodo = true;
        }
      }
    }

    roundsSinceTodo = usedTodo ? 0 : roundsSinceTodo + 1;

    // Nag reminder 注入
    if (roundsSinceTodo >= 3) {
      results.unshift({
        type: "text",
        text: "<reminder>Update your todos.</reminder>",
      });
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
  console.log("\n🤖 s03 TodoWrite (TypeScript)");
  console.log("=============================\n");

  // 初始化客户端
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.ANTHROPIC_BASE_URL,
  });

  const history: Anthropic.MessageParam[] = [];

  // REPL 循环
  while (true) {
    try {
      const query = await askQuestion("\x1b[36ms03 >> \x1b[0m");

      if (query.trim().toLowerCase() === "q" ||
          query.trim().toLowerCase() === "exit" ||
          query.trim() === "") {
        break;
      }

      history.push({
        role: "user",
        content: query,
      });

      await agentLoop(client, history);

      // 打印最终响应
      const lastContent = history[history.length - 1].content;
      if (Array.isArray(lastContent)) {
        for (const block of lastContent) {
          if (block.type === "text") {
            console.log((block as Anthropic.TextBlock).text);
          }
        }
      }
      console.log();
    } catch (error: any) {
      if (error.code === "EOF" || error.message?.includes("EOF")) {
        break;
      }
      console.error("错误:", error.message);
    }
  }
}

main().catch(console.error);
