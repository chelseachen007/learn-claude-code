/**
 * s11_autonomous_agents.ts - Autonomous Agents (TypeScript 版本)
 *
 * Idle cycle with task board polling, auto-claiming unclaimed tasks, and
 * identity re-injection after context compression. Builds on s10's protocols.
 *
 *     Teammate lifecycle:
 *     +-------+
 *     | spawn |
 *     +---+---+
 *         |
 *         v
 *     +-------+  tool_use    +-------+
 *     | WORK  | <----------- |  LLM  |
 *     +---+---+              +-------+
 *         |
 *         | stop_reason != tool_use
 *         v
 *     +--------+
 *     | IDLE   | poll every 5s for up to 60s
 *     +---+----+
 *         |
 *         +---> check inbox -> message? -> resume WORK
 *         |
 *         +---> scan .tasks/ -> unclaimed? -> claim -> resume WORK
 *         |
 *         +---> timeout (60s) -> shutdown
 *
 *     Identity re-injection after compression:
 *     messages = [identity_block, ...remaining...]
 *     "You are 'coder', role: backend, team: my-team"
 *
 * Key insight: "The agent finds work itself."
 */

import Anthropic from "@anthropic-ai/sdk";
import * as readline from "readline";
import { execSync, exec } from "child_process";
import { config } from "dotenv";
import * as path from "path";
import * as fs from "fs";
import { promisify } from "util";
import * as uuid from "uuid";

const execAsync = promisify(exec);

// 加载 .env 文件（从父目录）
config({ path: "../.env" });

// ============================================================================
// 配置
// ============================================================================

const MODEL = process.env.MODEL_ID || "claude-sonnet-4-20250514";
const WORKDIR = process.cwd();
const TEAM_DIR = path.join(WORKDIR, ".team");
const INBOX_DIR = path.join(TEAM_DIR, "inbox");
const TASKS_DIR = path.join(WORKDIR, ".tasks");

const POLL_INTERVAL = 5;
const IDLE_TIMEOUT = 60;

const SYSTEM = `You are a team lead at ${WORKDIR}. Teammates are autonomous -- they find work themselves.`;

const VALID_MSG_TYPES = [
  "message",
  "broadcast",
  "shutdown_request",
  "shutdown_response",
  "plan_approval_response",
];

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

interface TeamMember {
  name: string;
  role: string;
  status: "working" | "idle" | "shutdown";
}

interface TeamConfig {
  team_name: string;
  members: TeamMember[];
}

interface ShutdownRequest {
  target: string;
  status: "pending" | "approved" | "rejected";
}

interface PlanRequest {
  from: string;
  plan: string;
  status: "pending" | "approved" | "rejected";
}

// ============================================================================
// 全局状态
// ============================================================================

const shutdownRequests: Record<string, ShutdownRequest> = {};
const planRequests: Record<string, PlanRequest> = {};

// ============================================================================
// 工具函数
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
// MessageBus: JSONL inbox per teammate
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
    if (!VALID_MSG_TYPES.includes(msgType)) {
      return `Error: Invalid type '${msgType}'. Valid: ${VALID_MSG_TYPES.join(", ")}`;
    }
    const msg: Message = {
      type: msgType,
      from: sender,
      content,
      timestamp: Date.now() / 1000,
      ...extra,
    };
    const inboxPath = path.join(this.dir, `${to}.jsonl`);
    fs.appendFileSync(inboxPath, JSON.stringify(msg) + "\n");
    return `Sent ${msgType} to ${to}`;
  }

  readInbox(name: string): Message[] {
    const inboxPath = path.join(this.dir, `${name}.jsonl`);
    if (!fs.existsSync(inboxPath)) {
      return [];
    }
    const content = fs.readFileSync(inboxPath, "utf-8");
    const messages: Message[] = content
      .trim()
      .split("\n")
      .filter((line) => line)
      .map((line) => JSON.parse(line));
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
// Task board scanning
// ============================================================================

function scanUnclaimedTasks(): Task[] {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  const unclaimed: Task[] = [];
  const files = fs.readdirSync(TASKS_DIR).filter((f) => f.startsWith("task_") && f.endsWith(".json")).sort();

  for (const file of files) {
    const taskPath = path.join(TASKS_DIR, file);
    const task: Task = JSON.parse(fs.readFileSync(taskPath, "utf-8"));
    if (task.status === "pending" && !task.owner && (!task.blockedBy || task.blockedBy.length === 0)) {
      unclaimed.push(task);
    }
  }
  return unclaimed;
}

function claimTask(taskId: number, owner: string): string {
  const taskPath = path.join(TASKS_DIR, `task_${taskId}.json`);
  if (!fs.existsSync(taskPath)) {
    return `Error: Task ${taskId} not found`;
  }
  const task: Task = JSON.parse(fs.readFileSync(taskPath, "utf-8"));
  task.owner = owner;
  task.status = "in_progress";
  fs.writeFileSync(taskPath, JSON.stringify(task, null, 2));
  return `Claimed task #${taskId} for ${owner}`;
}

// ============================================================================
// Identity re-injection after compression
// ============================================================================

function makeIdentityBlock(name: string, role: string, teamName: string): Anthropic.MessageParam {
  return {
    role: "user",
    content: `<identity>You are '${name}', role: ${role}, team: ${teamName}. Continue your work.</identity>`,
  };
}

// ============================================================================
// TeammateManager - Autonomous teammate management
// ============================================================================

class TeammateManager {
  private dir: string;
  private configPath: string;
  private config: TeamConfig;
  private threads: Map<string, NodeJS.Timeout> = new Map();
  private running: Map<string, boolean> = new Map();
  private client: Anthropic;

  constructor(teamDir: string, client: Anthropic) {
    this.dir = teamDir;
    this.client = client;
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

  private setStatus(name: string, status: TeamMember["status"]): void {
    const member = this.findMember(name);
    if (member) {
      member.status = status;
      this.saveConfig();
    }
  }

  spawn(name: string, role: string, prompt: string): string {
    const member = this.findMember(name);
    if (member) {
      if (member.status !== "idle" && member.status !== "shutdown") {
        return `Error: '${name}' is currently ${member.status}`;
      }
      member.status = "working";
      member.role = role;
    } else {
      this.config.members.push({ name, role, status: "working" });
    }
    this.saveConfig();

    // Start the teammate loop
    this.running.set(name, true);
    this.loop(name, role, prompt);

    return `Spawned '${name}' (role: ${role})`;
  }

  private async loop(name: string, role: string, prompt: string): Promise<void> {
    const teamName = this.config.team_name;
    const sysPrompt = `You are '${name}', role: ${role}, team: ${teamName}, at ${WORKDIR}. Use idle tool when you have no more work. You will auto-claim new tasks.`;
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
    const tools = this.getTeammateTools();

    while (this.running.get(name)) {
      // -- WORK PHASE: standard agent loop --
      for (let i = 0; i < 50 && this.running.get(name); i++) {
        const inbox = BUS.readInbox(name);
        for (const msg of inbox) {
          if (msg.type === "shutdown_request") {
            this.setStatus(name, "shutdown");
            this.running.set(name, false);
            return;
          }
          messages.push({ role: "user", content: JSON.stringify(msg) });
        }

        try {
          const response = await this.client.messages.create({
            model: MODEL,
            system: sysPrompt,
            messages,
            tools,
            max_tokens: 8000,
          });

          messages.push({ role: "assistant", content: response.content });

          if (response.stop_reason !== "tool_use") {
            break;
          }

          const results: Anthropic.ToolResultBlockParam[] = [];
          let idleRequested = false;

          for (const block of response.content) {
            if (block.type === "tool_use") {
              let output: string;

              if (block.name === "idle") {
                idleRequested = true;
                output = "Entering idle phase. Will poll for new tasks.";
              } else {
                output = this.exec(name, block.name, block.input as Record<string, any>);
              }

              console.log(`  [${name}] ${block.name}: ${output.slice(0, 120)}`);
              results.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: output,
              });
            }
          }

          messages.push({ role: "user", content: results });

          if (idleRequested) {
            break;
          }
        } catch (error) {
          this.setStatus(name, "idle");
          return;
        }
      }

      if (!this.running.get(name)) return;

      // -- IDLE PHASE: poll for inbox messages and unclaimed tasks --
      this.setStatus(name, "idle");
      let resume = false;
      const polls = Math.floor(IDLE_TIMEOUT / Math.max(POLL_INTERVAL, 1));

      for (let i = 0; i < polls && this.running.get(name); i++) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL * 1000));

        const inbox = BUS.readInbox(name);
        if (inbox.length > 0) {
          for (const msg of inbox) {
            if (msg.type === "shutdown_request") {
              this.setStatus(name, "shutdown");
              this.running.set(name, false);
              return;
            }
            messages.push({ role: "user", content: JSON.stringify(msg) });
          }
          resume = true;
          break;
        }

        const unclaimed = scanUnclaimedTasks();
        if (unclaimed.length > 0) {
          const task = unclaimed[0];
          claimTask(task.id, name);

          const taskPrompt = `<auto-claimed>Task #${task.id}: ${task.subject}\n${task.description || ""}</auto-claimed>`;

          // Identity re-injection for compressed contexts
          if (messages.length <= 3) {
            messages.unshift(makeIdentityBlock(name, role, teamName));
            messages.splice(1, 0, { role: "assistant", content: `I am ${name}. Continuing.` });
          }

          messages.push({ role: "user", content: taskPrompt });
          messages.push({ role: "assistant", content: `Claimed task #${task.id}. Working on it.` });
          resume = true;
          break;
        }
      }

      if (!resume || !this.running.get(name)) {
        this.setStatus(name, "shutdown");
        this.running.set(name, false);
        return;
      }

      this.setStatus(name, "working");
    }
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
      case "shutdown_response": {
        const reqId = args.request_id;
        if (shutdownRequests[reqId]) {
          shutdownRequests[reqId].status = args.approve ? "approved" : "rejected";
        }
        BUS.send(sender, "lead", args.reason || "", "shutdown_response", {
          request_id: reqId,
          approve: args.approve,
        });
        return `Shutdown ${args.approve ? "approved" : "rejected"}`;
      }
      case "plan_approval": {
        const planText = args.plan || "";
        const reqId = uuid.v4().slice(0, 8);
        planRequests[reqId] = { from: sender, plan: planText, status: "pending" };
        BUS.send(sender, "lead", planText, "plan_approval_response", {
          request_id: reqId,
          plan: planText,
        });
        return `Plan submitted (request_id=${reqId}). Waiting for approval.`;
      }
      case "claim_task":
        return claimTask(args.task_id, sender);
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
            msg_type: { type: "string", enum: VALID_MSG_TYPES },
          },
          required: ["to", "content"],
        },
      },
      {
        name: "read_inbox",
        description: "Read and drain your inbox.",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "shutdown_response",
        description: "Respond to a shutdown request.",
        input_schema: {
          type: "object",
          properties: {
            request_id: { type: "string" },
            approve: { type: "boolean" },
            reason: { type: "string" },
          },
          required: ["request_id", "approve"],
        },
      },
      {
        name: "plan_approval",
        description: "Submit a plan for lead approval.",
        input_schema: {
          type: "object",
          properties: { plan: { type: "string" } },
          required: ["plan"],
        },
      },
      {
        name: "idle",
        description: "Signal that you have no more work. Enters idle polling phase.",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "claim_task",
        description: "Claim a task from the task board by ID.",
        input_schema: {
          type: "object",
          properties: { task_id: { type: "integer" } },
          required: ["task_id"],
        },
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

  stopAll(): void {
    for (const name of this.running.keys()) {
      this.running.set(name, false);
    }
  }
}

// ============================================================================
// Lead-specific protocol handlers
// ============================================================================

function handleShutdownRequest(teammate: string): string {
  const reqId = uuid.v4().slice(0, 8);
  shutdownRequests[reqId] = { target: teammate, status: "pending" };
  BUS.send("lead", teammate, "Please shut down gracefully.", "shutdown_request", { request_id: reqId });
  return `Shutdown request ${reqId} sent to '${teammate}'`;
}

function handlePlanReview(requestId: string, approve: boolean, feedback: string = ""): string {
  const req = planRequests[requestId];
  if (!req) {
    return `Error: Unknown plan request_id '${requestId}'`;
  }
  req.status = approve ? "approved" : "rejected";
  BUS.send("lead", req.from, feedback, "plan_approval_response", {
    request_id: requestId,
    approve,
    feedback,
  });
  return `Plan ${req.status} for '${req.from}'`;
}

function checkShutdownStatus(requestId: string): string {
  return JSON.stringify(shutdownRequests[requestId] || { error: "not found" });
}

// ============================================================================
// Lead tool dispatch
// ============================================================================

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const TEAM = new TeammateManager(TEAM_DIR, client);

const TOOL_HANDLERS: Record<string, (args: Record<string, any>) => string> = {
  bash: (args) => runBash(args.command),
  read_file: (args) => runRead(args.path, args.limit),
  write_file: (args) => runWrite(args.path, args.content),
  edit_file: (args) => runEdit(args.path, args.old_text, args.new_text),
  spawn_teammate: (args) => TEAM.spawn(args.name, args.role, args.prompt),
  list_teammates: () => TEAM.listAll(),
  send_message: (args) => BUS.send("lead", args.to, args.content, args.msg_type || "message"),
  read_inbox: () => JSON.stringify(BUS.readInbox("lead"), null, 2),
  broadcast: (args) => BUS.broadcast("lead", args.content, TEAM.memberNames()),
  shutdown_request: (args) => handleShutdownRequest(args.teammate),
  shutdown_response: (args) => checkShutdownStatus(args.request_id || ""),
  plan_approval: (args) => handlePlanReview(args.request_id, args.approve, args.feedback || ""),
  idle: () => "Lead does not idle.",
  claim_task: (args) => claimTask(args.task_id, "lead"),
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
    description: "Spawn an autonomous teammate.",
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
    description: "List all teammates.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "send_message",
    description: "Send a message to a teammate.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string" },
        content: { type: "string" },
        msg_type: { type: "string", enum: VALID_MSG_TYPES },
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
  {
    name: "shutdown_request",
    description: "Request a teammate to shut down.",
    input_schema: {
      type: "object",
      properties: { teammate: { type: "string" } },
      required: ["teammate"],
    },
  },
  {
    name: "shutdown_response",
    description: "Check shutdown request status.",
    input_schema: {
      type: "object",
      properties: { request_id: { type: "string" } },
      required: ["request_id"],
    },
  },
  {
    name: "plan_approval",
    description: "Approve or reject a teammate's plan.",
    input_schema: {
      type: "object",
      properties: {
        request_id: { type: "string" },
        approve: { type: "boolean" },
        feedback: { type: "string" },
      },
      required: ["request_id", "approve"],
    },
  },
  {
    name: "idle",
    description: "Enter idle state (for lead -- rarely used).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "claim_task",
    description: "Claim a task from the board by ID.",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "integer" } },
      required: ["task_id"],
    },
  },
];

// ============================================================================
// Agent Loop
// ============================================================================

async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
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

function listTasks(): void {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  const files = fs.readdirSync(TASKS_DIR).filter((f) => f.startsWith("task_") && f.endsWith(".json")).sort();

  for (const file of files) {
    const taskPath = path.join(TASKS_DIR, file);
    const t: Task = JSON.parse(fs.readFileSync(taskPath, "utf-8"));
    const marker = { pending: "[ ]", in_progress: "[>]", completed: "[x]" }[t.status] || "[?]";
    const owner = t.owner ? ` @${t.owner}` : "";
    console.log(`  ${marker} #${t.id}: ${t.subject}${owner}`);
  }
}

// ============================================================================
// 主函数
// ============================================================================

async function main() {
  console.log("\n🤖 s11 Autonomous Agents (TypeScript)");
  console.log("======================================\n");

  const history: Anthropic.MessageParam[] = [];

  while (true) {
    try {
      const query = await askQuestion("\x1b[36ms11 >> \x1b[0m");

      if (query.trim().toLowerCase() === "q" || query.trim().toLowerCase() === "exit" || query.trim() === "") {
        TEAM.stopAll();
        break;
      }

      if (query.trim() === "/team") {
        console.log(TEAM.listAll());
        continue;
      }

      if (query.trim() === "/inbox") {
        console.log(JSON.stringify(BUS.readInbox("lead"), null, 2));
        continue;
      }

      if (query.trim() === "/tasks") {
        listTasks();
        continue;
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
        TEAM.stopAll();
        break;
      }
      console.error("错误:", error.message);
    }
  }
}

main();
