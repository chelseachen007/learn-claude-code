/**
 * s09_agent_teams.ts - Agent Teams (TypeScript 版本)
 *
 * Persistent named agents with file-based JSONL inboxes. Each teammate runs
 * its own agent loop in a separate thread. Communication via append-only inboxes.
 *
 *     Subagent (s04):  spawn -> execute -> return summary -> destroyed
 *     Teammate (s09):  spawn -> work -> idle -> work -> ... -> shutdown
 *
 *     .team/config.json                   .team/inbox/
 *     +----------------------------+      +------------------+
 *     | {"team_name": "default",   |      | alice.jsonl      |
 *     |  "members": [              |      | bob.jsonl        |
 *     |    {"name":"alice",        |      | lead.jsonl       |
 *     |     "role":"coder",        |      +------------------+
 *     |     "status":"idle"}       |
 *     |  ]}                        |      send_message("alice", "fix bug"):
 *     +----------------------------+        open("alice.jsonl", "a").write(msg)
 *
 *                                     read_inbox("alice"):
 *     spawn_teammate("alice","coder",...)   msgs = [json.loads(l) for l in ...]
 *          |                                open("alice.jsonl", "w").close()
 *          v                                return msgs  # drain
 *     Thread: alice             Thread: bob
 *     +------------------+      +------------------+
 *     | agent_loop       |      | agent_loop       |
 *     | status: working  |      | status: idle     |
 *     | ... runs tools   |      | ... waits ...    |
 *     | status -> idle   |      |                  |
 *     +------------------+      +------------------+
 *
 *     5 message types (all declared, not all handled here):
 *     +-------------------------+-----------------------------------+
 *     | message                 | Normal text message               |
 *     | broadcast               | Sent to all teammates             |
 *     | shutdown_request        | Request graceful shutdown (s10)   |
 *     | shutdown_response       | Approve/reject shutdown (s10)     |
 *     | plan_approval_response  | Approve/reject plan (s10)         |
 *     +-------------------------+-----------------------------------+
 *
 * Key insight: "Teammates that can talk to each other."
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";
import { config } from "dotenv";
import * as path from "path";
import * as fs from "fs";
import * as readline from "readline";
import * as os from "os";

// 加载 .env 文件（从父目录）
config({ path: "../.env" });

// ============================================================================
// 配置
// ============================================================================

const MODEL = process.env.MODEL_ID || "claude-sonnet-4-20250514";
const WORKDIR = process.cwd();
const TEAM_DIR = path.join(WORKDIR, ".team");
const INBOX_DIR = path.join(TEAM_DIR, "inbox");
const SYSTEM = `You are a team lead at ${WORKDIR}. Spawn teammates and communicate via inboxes.`;

const VALID_MSG_TYPES = new Set([
  "message",
  "broadcast",
  "shutdown_request",
  "shutdown_response",
  "plan_approval_response",
]);

// ============================================================================
// 类型定义
// ============================================================================

interface Message {
  type: string;
  from: string;
  content: string;
  timestamp: number;
  [key: string]: any;
}

interface TeamMember {
  name: string;
  role: string;
  status: "idle" | "working" | "shutdown";
}

interface TeamConfig {
  team_name: string;
  members: TeamMember[];
}

// ============================================================================
// MessageBus: JSONL 收件箱
// ============================================================================

class MessageBus {
  private dir: string;

  constructor(inboxDir: string) {
    this.dir = inboxDir;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  send(
    sender: string,
    to: string,
    content: string,
    msgType: string = "message",
    extra?: Record<string, any>
  ): string {
    if (!VALID_MSG_TYPES.has(msgType)) {
      return `Error: Invalid type '${msgType}'. Valid: ${[...VALID_MSG_TYPES].join(", ")}`;
    }

    const msg: Message = {
      type: msgType,
      from: sender,
      content: content,
      timestamp: Date.now() / 1000,
    };

    if (extra) {
      Object.assign(msg, extra);
    }

    const inboxPath = path.join(this.dir, `${to}.jsonl`);
    fs.appendFileSync(inboxPath, JSON.stringify(msg) + "\n");
    return `Sent ${msgType} to ${to}`;
  }

  readInbox(name: string): Message[] {
    const inboxPath = path.join(this.dir, `${name}.jsonl`);
    if (!fs.existsSync(inboxPath)) {
      return [];
    }

    const content = fs.readFileSync(inboxPath, "utf-8").trim();
    const messages: Message[] = [];
    for (const line of content.split("\n")) {
      if (line.trim()) {
        messages.push(JSON.parse(line));
      }
    }

    // 清空收件箱
    fs.writeFileSync(inboxPath, "");
    return messages;
  }

  broadcast(sender: string, content: string, teammates: string[]): string {
    let count = 0;
    for (const name of teammates) {
      if (name !== sender) {
        this.send(sender, name, content, "broadcast");
        count++;
      }
    }
    return `Broadcast to ${count} teammates`;
  }
}

const BUS = new MessageBus(INBOX_DIR);

// ============================================================================
// 基础工具实现
// ============================================================================

function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot"];
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
    if (error.stdout !== undefined) {
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
// TeammateManager: 持久化命名的 Agent
// ============================================================================

class TeammateManager {
  private dir: string;
  private configPath: string;
  private config: TeamConfig;
  private threads: Map<string, boolean> = new Map();

  constructor(teamDir: string) {
    this.dir = teamDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.configPath = path.join(this.dir, "config.json");
    this.config = this.loadConfig();
  }

  private loadConfig(): TeamConfig {
    if (fs.existsSync(this.configPath)) {
      return JSON.parse(fs.readFileSync(this.configPath, "utf-8"));
    }
    return { team_name: "default", members: [] };
  }

  private saveConfig(): void {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  private findMember(name: string): TeamMember | undefined {
    return this.config.members.find((m) => m.name === name);
  }

  spawn(name: string, role: string, prompt: string): string {
    let member = this.findMember(name);
    if (member) {
      if (member.status !== "idle" && member.status !== "shutdown") {
        return `Error: '${name}' is currently ${member.status}`;
      }
      member.status = "working";
      member.role = role;
    } else {
      member = { name, role, status: "working" };
      this.config.members.push(member);
    }
    this.saveConfig();

    // 使用 setImmediate 模拟线程执行
    this.threads.set(name, true);
    setImmediate(() => this.teammateLoop(name, role, prompt));

    return `Spawned '${name}' (role: ${role})`;
  }

  private async teammateLoop(
    name: string,
    role: string,
    prompt: string
  ): Promise<void> {
    const client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: process.env.ANTHROPIC_BASE_URL,
    });

    const sysPrompt = `You are '${name}', role: ${role}, at ${WORKDIR}. Use send_message to communicate. Complete your task.`;
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
    const tools = this.getTeammateTools();

    for (let i = 0; i < 50; i++) {
      // 检查是否还在运行
      if (!this.threads.get(name)) break;

      // 读取收件箱
      const inbox = BUS.readInbox(name);
      for (const msg of inbox) {
        messages.push({ role: "user", content: JSON.stringify(msg) });
      }

      try {
        const response = await client.messages.create({
          model: MODEL,
          system: sysPrompt,
          messages: messages,
          tools: tools,
          max_tokens: 8000,
        });

        messages.push({ role: "assistant", content: response.content });

        if (response.stop_reason !== "tool_use") {
          break;
        }

        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const block of response.content) {
          if (block.type === "tool_use") {
            const output = this.exec(name, block.name, block.input as Record<string, any>);
            console.log(`  [${name}] ${block.name}: ${output.slice(0, 120)}`);
            results.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: output,
            });
          }
        }
        messages.push({ role: "user", content: results });
      } catch (error) {
        break;
      }
    }

    // 更新状态
    const member = this.findMember(name);
    if (member && member.status !== "shutdown") {
      member.status = "idle";
      this.saveConfig();
    }
    this.threads.delete(name);
  }

  private exec(sender: string, toolName: string, args: Record<string, any>): string {
    switch (toolName) {
      case "bash":
        return runBash(args.command);
      case "read_file":
        return runRead(args.path);
      case "write_file":
        return runWrite(args.path, args.content);
      case "edit_file":
        return runEdit(args.path, args.old_text, args.new_text);
      case "send_message":
        return BUS.send(sender, args.to, args.content, args.msg_type || "message");
      case "read_inbox":
        return JSON.stringify(BUS.readInbox(sender), null, 2);
      default:
        return `Unknown tool: ${toolName}`;
    }
  }

  private getTeammateTools(): Anthropic.Tool[] {
    return [
      {
        name: "bash",
        description: "Run a shell command.",
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
          properties: { path: { type: "string" } },
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
        name: "send_message",
        description: "Send message to a teammate.",
        input_schema: {
          type: "object",
          properties: {
            to: { type: "string" },
            content: { type: "string" },
            msg_type: { type: "string", enum: [...VALID_MSG_TYPES] },
          },
          required: ["to", "content"],
        },
      },
      {
        name: "read_inbox",
        description: "Read and drain your inbox.",
        input_schema: { type: "object", properties: {} },
      },
    ];
  }

  listAll(): string {
    if (this.config.members.length === 0) {
      return "No teammates.";
    }
    const lines = [`Team: ${this.config.team_name}`];
    for (const m of this.config.members) {
      lines.push(`  ${m.name} (${m.role}): ${m.status}`);
    }
    return lines.join("\n");
  }

  memberNames(): string[] {
    return this.config.members.map((m) => m.name);
  }
}

const TEAM = new TeammateManager(TEAM_DIR);

// ============================================================================
// Lead 工具调度
// ============================================================================

const TOOL_HANDLERS: Record<string, (input: any) => string> = {
  bash: (input) => runBash(input.command),
  read_file: (input) => runRead(input.path, input.limit),
  write_file: (input) => runWrite(input.path, input.content),
  edit_file: (input) => runEdit(input.path, input.old_text, input.new_text),
  spawn_teammate: (input) => TEAM.spawn(input.name, input.role, input.prompt),
  list_teammates: () => TEAM.listAll(),
  send_message: (input) => BUS.send("lead", input.to, input.content, input.msg_type || "message"),
  read_inbox: () => JSON.stringify(BUS.readInbox("lead"), null, 2),
  broadcast: (input) => BUS.broadcast("lead", input.content, TEAM.memberNames()),
};

const TOOLS: Anthropic.Tool[] = [
  {
    name: "bash",
    description: "Run a shell command.",
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
    name: "spawn_teammate",
    description: "Spawn a persistent teammate that runs in its own thread.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        role: { type: "string" },
        prompt: { type: "string" },
      },
      required: ["name", "role", "prompt"],
    },
  },
  {
    name: "list_teammates",
    description: "List all teammates with name, role, status.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "send_message",
    description: "Send a message to a teammate's inbox.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string" },
        content: { type: "string" },
        msg_type: { type: "string", enum: [...VALID_MSG_TYPES] },
      },
      required: ["to", "content"],
    },
  },
  {
    name: "read_inbox",
    description: "Read and drain the lead's inbox.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "broadcast",
    description: "Send a message to all teammates.",
    input_schema: {
      type: "object",
      properties: { content: { type: "string" } },
      required: ["content"],
    },
  },
];

// ============================================================================
// Agent 循环
// ============================================================================

async function agentLoop(
  client: Anthropic,
  messages: Anthropic.MessageParam[]
): Promise<void> {
  while (true) {
    // 读取 lead 的收件箱
    const inbox = BUS.readInbox("lead");
    if (inbox.length > 0) {
      messages.push({
        role: "user",
        content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>`,
      });
      messages.push({
        role: "assistant",
        content: "Noted inbox messages.",
      });
    }

    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages: messages,
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
        let output: string;
        try {
          output = TOOL_HANDLERS[block.name]?.(block.input) || `Unknown tool: ${block.name}`;
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
  console.log("\ns09 Agent Teams (TypeScript)");
  console.log("=============================\n");

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.ANTHROPIC_BASE_URL,
  });

  const history: Anthropic.MessageParam[] = [];

  // REPL 循环
  while (true) {
    let query: string;
    try {
      query = await askQuestion("\x1b[36ms09 >> \x1b[0m");
    } catch (error) {
      break;
    }

    if (query.trim().toLowerCase() === "q" || query.trim().toLowerCase() === "exit" || query.trim() === "") {
      break;
    }

    // 特殊命令
    if (query.trim() === "/team") {
      console.log(TEAM.listAll());
      continue;
    }
    if (query.trim() === "/inbox") {
      console.log(JSON.stringify(BUS.readInbox("lead"), null, 2));
      continue;
    }

    history.push({ role: "user", content: query });
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
