/**
 * s06_context_compact.ts - Compact (TypeScript 版本)
 *
 * Three-layer compression pipeline so the agent can work forever:
 *
 *     Every turn:
 *     +------------------+
 *     | Tool call result |
 *     +------------------+
 *             |
 *             v
 *     [Layer 1: micro_compact]        (silent, every turn)
 *       Replace tool_result content older than last 3
 *       with "[Previous: used {tool_name}]"
 *             |
 *             v
 *     [Check: tokens > 50000?]
 *        |               |
 *        no              yes
 *        |               |
 *        v               v
 *     continue    [Layer 2: auto_compact]
 *                   Save full transcript to .transcripts/
 *                   Ask LLM to summarize conversation.
 *                   Replace all messages with [summary].
 *                         |
 *                         v
 *                 [Layer 3: compact tool]
 *                   Model calls compact -> immediate summarization.
 *                   Same as auto, triggered manually.
 *
 * Key insight: "The agent can forget strategically and keep working forever."
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
const THRESHOLD = 50000;
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");
const KEEP_RECENT = 3;

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.`;

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
    name: "compact",
    description: "Trigger manual conversation compression.",
    input_schema: {
      type: "object",
      properties: {
        focus: { type: "string", description: "What to preserve in the summary" },
      },
    },
  },
];

// ============================================================================
// Token 估算
// ============================================================================

function estimateTokens(messages: Anthropic.MessageParam[]): number {
  // Rough token count: ~4 chars per token
  return Math.floor(JSON.stringify(messages).length / 4);
}

// ============================================================================
// Layer 1: micro_compact - replace old tool results with placeholders
// ============================================================================

function microCompact(messages: Anthropic.MessageParam[]): void {
  // Collect (msg_index, part_index, tool_result) for all tool_result entries
  interface ToolResultEntry {
    msgIdx: number;
    partIdx: number;
    result: Anthropic.ToolResultBlockParam;
  }

  const toolResults: ToolResultEntry[] = [];

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (let partIdx = 0; partIdx < msg.content.length; partIdx++) {
        const part = msg.content[partIdx];
        if (typeof part === "object" && part !== null && part.type === "tool_result") {
          toolResults.push({
            msgIdx,
            partIdx,
            result: part as Anthropic.ToolResultBlockParam,
          });
        }
      }
    }
  }

  if (toolResults.length <= KEEP_RECENT) {
    return;
  }

  // Find tool_name for each result by matching tool_use_id in prior assistant messages
  const toolNameMap: Record<string, string> = {};

  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block === "object" && block !== null && block.type === "tool_use") {
          const toolBlock = block as Anthropic.ToolUseBlock;
          toolNameMap[toolBlock.id] = toolBlock.name;
        }
      }
    }
  }

  // Clear old results (keep last KEEP_RECENT)
  const toClear = toolResults.slice(0, -KEEP_RECENT);

  for (const entry of toClear) {
    const content = entry.result.content;
    if (typeof content === "string" && content.length > 100) {
      const toolId = entry.result.tool_use_id;
      const toolName = toolNameMap[toolId] || "unknown";
      entry.result.content = `[Previous: used ${toolName}]`;
    }
  }
}

// ============================================================================
// Layer 2 & 3: auto_compact - save transcript, summarize, replace messages
// ============================================================================

async function autoCompact(
  client: Anthropic,
  messages: Anthropic.MessageParam[]
): Promise<Anthropic.MessageParam[]> {
  // Save full transcript to disk
  if (!fs.existsSync(TRANSCRIPT_DIR)) {
    fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const transcriptPath = path.join(TRANSCRIPT_DIR, `transcript_${timestamp}.jsonl`);

  const writeStream = fs.createWriteStream(transcriptPath);
  for (const msg of messages) {
    writeStream.write(JSON.stringify(msg) + "\n");
  }
  writeStream.end();

  console.log(`[transcript saved: ${transcriptPath}]`);

  // Ask LLM to summarize
  const conversationText = JSON.stringify(messages).slice(0, 80000);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    messages: [
      {
        role: "user",
        content:
          "Summarize this conversation for continuity. Include: " +
          "1) What was accomplished, 2) Current state, 3) Key decisions made. " +
          "Be concise but preserve critical details.\n\n" +
          conversationText,
      },
    ],
  });

  const summaryBlock = response.content.find((b) => b.type === "text") as Anthropic.TextBlock | undefined;
  const summary = summaryBlock?.text || "";

  // Replace all messages with compressed summary
  return [
    {
      role: "user",
      content: `[Conversation compressed. Transcript: ${transcriptPath}]\n\n${summary}`,
    },
    {
      role: "assistant",
      content: "Understood. I have the context from the summary. Continuing.",
    },
  ];
}

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
  focus?: string;
}

const TOOL_HANDLERS: Record<string, (input: ToolInput) => string> = {
  bash: (input) => runBash(input.command!),
  read_file: (input) => runRead(input.path!, input.limit),
  write_file: (input) => runWrite(input.path!, input.content!),
  edit_file: (input) => runEdit(input.path!, input.old_text!, input.new_text!),
  compact: () => "Manual compression requested.",
};

// ============================================================================
// Agent 循环 - 核心逻辑
// ============================================================================

async function agentLoop(
  client: Anthropic,
  messages: Anthropic.MessageParam[]
): Promise<void> {
  while (true) {
    // Layer 1: micro_compact before each LLM call
    microCompact(messages);

    // Layer 2: auto_compact if token estimate exceeds threshold
    if (estimateTokens(messages) > THRESHOLD) {
      console.log("[auto_compact triggered]");
      const newMessages = await autoCompact(client, messages);
      messages.length = 0;
      messages.push(...newMessages);
    }

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
    let manualCompact = false;

    for (const block of response.content) {
      if (block.type === "tool_use") {
        if (block.name === "compact") {
          manualCompact = true;
        }

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

    // Layer 3: manual compact triggered by the compact tool
    if (manualCompact) {
      console.log("[manual compact]");
      const newMessages = await autoCompact(client, messages);
      messages.length = 0;
      messages.push(...newMessages);
    }
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
  console.log("\n🤖 s06 Context Compact (TypeScript)");
  console.log("====================================\n");

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
      query = await askQuestion("\x1b[36ms06 >> \x1b[0m");
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
