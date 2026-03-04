/**
 * s04_subagent.ts - Subagents (TypeScript 版本)
 *
 * 格言: "Process isolation gives context isolation for free."
 *
 * Spawn a child agent with fresh messages=[]. The child works in its own
 * context, sharing the filesystem, then returns only a summary to the parent.
 *
 *     Parent agent                     Subagent
 *     +------------------+             +------------------+
 *     | messages=[...]   |             | messages=[]      |  <-- fresh
 *     |                  |  dispatch   |                  |
 *     | tool: task       | ---------->| while tool_use:  |
 *     |   prompt="..."   |            |   call tools     |
 *     |   description="" |            |   append results |
 *     |                  |  summary   |                  |
 *     |   result = "..." | <--------- | return last text |
 *     +------------------+             +------------------+
 *               |
 *     Parent context stays clean.
 *     Subagent context is discarded.
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

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use the task tool to delegate exploration or subtasks.`;
const SUBAGENT_SYSTEM = `You are a coding subagent at ${WORKDIR}. Complete the given task, then summarize your findings.`;

// ============================================================================
// 工具定义
// ============================================================================

// 子 agent 获取所有基础工具，除了 task（不能递归生成）
const CHILD_TOOLS: Anthropic.Tool[] = [
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
];

// 父 agent 工具: 基础工具 + task 调度器
const PARENT_TOOLS: Anthropic.Tool[] = [
  ...CHILD_TOOLS,
  {
    name: "task",
    description: "Spawn a subagent with fresh context. It shares the filesystem but not conversation history.",
    input_schema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
        },
        description: {
          type: "string",
          description: "Short description of the task",
        },
      },
      required: ["prompt"],
    },
  },
];

// ============================================================================
// 工具处理器 - 父子共享
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
};

// ============================================================================
// Subagent: 新鲜上下文，过滤工具，只返回摘要
// ============================================================================

async function runSubagent(client: Anthropic, prompt: string): Promise<string> {
  const subMessages: Anthropic.MessageParam[] = [
    { role: "user", content: prompt }, // fresh context
  ];

  let lastResponse: Anthropic.Message | null = null;

  for (let i = 0; i < 30; i++) { // safety limit
    const response = await client.messages.create({
      model: MODEL,
      system: SUBAGENT_SYSTEM,
      messages: subMessages,
      tools: CHILD_TOOLS,
      max_tokens: 8000,
    });

    lastResponse = response;
    subMessages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      break;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = TOOL_HANDLERS[block.name];
        const output = handler
          ? handler(block.input)
          : `Unknown tool: ${block.name}`;
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: String(output).slice(0, 50000),
        });
      }
    }

    subMessages.push({ role: "user", content: results });
  }

  // 只有最后的文本返回给父 agent -- 子 agent 上下文被丢弃
  if (lastResponse) {
    const textParts: string[] = [];
    for (const block of lastResponse.content) {
      if (block.type === "text") {
        textParts.push((block as Anthropic.TextBlock).text);
      }
    }
    return textParts.join("") || "(no summary)";
  }

  return "(no summary)";
}

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
      system: SYSTEM,
      messages: messages,
      tools: PARENT_TOOLS,
      max_tokens: 8000,
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
        let output: string;

        if (block.name === "task") {
          const desc = (block.input as any).description || "subtask";
          const prompt = (block.input as any).prompt;
          console.log(`> task (${desc}): ${prompt.slice(0, 80)}`);
          output = await runSubagent(client, prompt);
        } else {
          const handler = TOOL_HANDLERS[block.name];
          output = handler
            ? handler(block.input)
            : `Unknown tool: ${block.name}`;
        }

        console.log(`  ${String(output).slice(0, 200)}`);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: String(output),
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
  console.log("\n🤖 s04 Subagent (TypeScript)");
  console.log("============================\n");

  // 初始化客户端
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.ANTHROPIC_BASE_URL,
  });

  const history: Anthropic.MessageParam[] = [];

  // REPL 循环
  while (true) {
    try {
      const query = await askQuestion("\x1b[36ms04 >> \x1b[0m");

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
