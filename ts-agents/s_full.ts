/**
 * s_full.ts - Full Reference Agent (TypeScript 版本)
 *
 * Capstone implementation combining every mechanism from s01-s11.
 * Session s12 (task-aware worktree isolation) is taught separately.
 * NOT a teaching session -- this is the "put it all together" reference.
 *
 *     +------------------------------------------------------------------+
 *     |                        FULL AGENT                                 |
 *     |                                                                   |
 *     |  System prompt (s05 skills, task-first + optional todo nag)      |
 *     |                                                                   |
 *     |  Before each LLM call:                                            |
 *     |  +--------------------+  +------------------+  +--------------+  |
 *     |  | Microcompact (s06) |  | Drain bg (s08)   |  | Check inbox  |  |
 *     |  | Auto-compact (s06) |  | notifications    |  | (s09)        |  |
 *     |  +--------------------+  +------------------+  +--------------+  |
 *     |                                                                   |
 *     |  Tool dispatch (s02 pattern):                                     |
 *     |  +--------+----------+----------+---------+-----------+          |
 *     |  | bash   | read     | write    | edit    | TodoWrite |          |
 *     |  | task   | load_sk  | compress | bg_run  | bg_check  |          |
 *     |  | t_crt  | t_get    | t_upd    | t_list  | spawn_tm  |          |
 *     |  | list_tm| send_msg | rd_inbox | bcast   | shutdown  |          |
 *     |  | plan   | idle     | claim    |         |           |          |
 *     |  +--------+----------+----------+---------+-----------+          |
 *     |                                                                   |
 *     |  Subagent (s04):  spawn -> work -> return summary                 |
 *     |  Teammate (s09):  spawn -> work -> idle -> auto-claim (s11)      |
 *     |  Shutdown (s10):  request_id handshake                            |
 *     |  Plan gate (s10): submit -> approve/reject                        |
 *     +------------------------------------------------------------------+
 *
 *     REPL commands: /compact /tasks /team /inbox
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
const SKILLS_DIR = path.join(WORKDIR, "skills");
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");
const TOKEN_THRESHOLD = 100000;
const POLL_INTERVAL = 5;
const IDLE_TIMEOUT = 60;

const VALID_MSG_TYPES = ["message", "broadcast", "shutdown_request", "shutdown_response", "plan_approval_response"];

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
  status: "pending" | "in_progress" | "completed" | "deleted";
  owner?: string;
  blockedBy?: number[];
  blocks?: number[];
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

interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

interface BackgroundTask {
  status: "running" | "completed" | "error";
  command: string;
  result?: string;
}

interface BackgroundNotification {
  task_id: string;
  status: string;
  result: string;
}

interface Skill {
  meta: Record<string, string>;
  body: string;
}

// ============================================================================
// 全局状态
// ============================================================================

const shutdownRequests: Record<string, ShutdownRequest> = {};
const planRequests: Record<string, PlanRequest> = {};

// ============================================================================
// Base Tools
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
    return `Wrote ${content.length} bytes to ${filePath}`;
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
// TodoManager (s03)
// ============================================================================

class TodoManager {
  private items: TodoItem[] = [];

  update(items: TodoItem[]): string {
    const validated: TodoItem[] = [];
    let inProgressCount = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const content = String(item.content || "").trim();
      const status = String(item.status || "pending").toLowerCase() as TodoItem["status"];
      const activeForm = String(item.activeForm || "").trim();

      if (!content) throw new Error(`Item ${i}: content required`);
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Item ${i}: invalid status '${status}'`);
      }
      if (!activeForm) throw new Error(`Item ${i}: activeForm required`);
      if (status === "in_progress") inProgressCount++;

      validated.push({ content, status, activeForm });
    }

    if (validated.length > 20) throw new Error("Max 20 todos");
    if (inProgressCount > 1) throw new Error("Only one in_progress allowed");

    this.items = validated;
    return this.render();
  }

  render(): string {
    if (this.items.length === 0) return "No todos.";
    const lines: string[] = [];
    for (const item of this.items) {
      const m = { completed: "[x]", in_progress: "[>]", pending: "[ ]" }[item.status] || "[?]";
      const suffix = item.status === "in_progress" ? ` <- ${item.activeForm}` : "";
      lines.push(`${m} ${item.content}${suffix}`);
    }
    const done = this.items.filter((t) => t.status === "completed").length;
    lines.push(`\n(${done}/${this.items.length} completed)`);
    return lines.join("\n");
  }

  hasOpenItems(): boolean {
    return this.items.some((item) => item.status !== "completed");
  }
}

// ============================================================================
// Subagent (s04)
// ============================================================================

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

async function runSubagent(prompt: string, agentType: string = "Explore"): Promise<string> {
  const subTools: Anthropic.Tool[] = [
    {
      name: "bash",
      description: "Run command.",
      input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
    {
      name: "read_file",
      description: "Read file.",
      input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  ];

  if (agentType !== "Explore") {
    subTools.push(
      {
        name: "write_file",
        description: "Write file.",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
      },
      {
        name: "edit_file",
        description: "Edit file.",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } },
          required: ["path", "old_text", "new_text"],
        },
      }
    );
  }

  const subHandlers: Record<string, (args: Record<string, any>) => string> = {
    bash: (args) => runBash(args.command),
    read_file: (args) => runRead(args.path),
    write_file: (args) => runWrite(args.path, args.content),
    edit_file: (args) => runEdit(args.path, args.old_text, args.new_text),
  };

  const subMsgs: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
  let response: Anthropic.Message | null = null;

  for (let i = 0; i < 30; i++) {
    response = await client.messages.create({
      model: MODEL,
      messages: subMsgs,
      tools: subTools,
      max_tokens: 8000,
    });

    subMsgs.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      break;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = subHandlers[block.name] || (() => "Unknown tool");
        const output = handler(block.input as Record<string, any>).slice(0, 50000);
        results.push({ type: "tool_result", tool_use_id: block.id, content: output });
      }
    }
    subMsgs.push({ role: "user", content: results });
  }

  if (response) {
    const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text");
    return textBlocks.map((b) => b.text).join("") || "(no summary)";
  }
  return "(subagent failed)";
}

// ============================================================================
// Skills (s05)
// ============================================================================

class SkillLoader {
  private skills: Map<string, Skill> = new Map();

  constructor(skillsDir: string) {
    if (fs.existsSync(skillsDir)) {
      const files = this.walkDir(skillsDir).filter((f) => f.endsWith("SKILL.md"));
      for (const file of files) {
        const text = fs.readFileSync(file, "utf-8");
        const match = text.match(/^---\n(.*?)\n---\n(.*)/s);
        let meta: Record<string, string> = {};
        let body = text;

        if (match) {
          for (const line of match[1].trim().split("\n")) {
            const colonIdx = line.indexOf(":");
            if (colonIdx > 0) {
              meta[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
            }
          }
          body = match[2].trim();
        }

        const name = meta.name || path.basename(path.dirname(file));
        this.skills.set(name, { meta, body });
      }
    }
  }

  private walkDir(dir: string): string[] {
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        results.push(...this.walkDir(fullPath));
      } else {
        results.push(fullPath);
      }
    }
    return results;
  }

  descriptions(): string {
    if (this.skills.size === 0) return "(no skills)";
    const lines: string[] = [];
    for (const [name, skill] of this.skills) {
      lines.push(`  - ${name}: ${skill.meta.description || "-"}`);
    }
    return lines.join("\n");
  }

  load(name: string): string {
    const skill = this.skills.get(name);
    if (!skill) {
      return `Error: Unknown skill '${name}'. Available: ${Array.from(this.skills.keys()).join(", ")}`;
    }
    return `<skill name="${name}">\n${skill.body}\n</skill>`;
  }
}

// ============================================================================
// Compression (s06)
// ============================================================================

function estimateTokens(messages: Anthropic.MessageParam[]): number {
  return Math.floor(JSON.stringify(messages).length / 4);
}

function microcompact(messages: Anthropic.MessageParam[]): void {
  const toolResults: { msgIdx: number; partIdx: number; part: any }[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (let j = 0; j < msg.content.length; j++) {
        const part = msg.content[j];
        if (typeof part === "object" && part?.type === "tool_result") {
          toolResults.push({ msgIdx: i, partIdx: j, part });
        }
      }
    }
  }

  if (toolResults.length <= 3) return;

  for (let i = 0; i < toolResults.length - 3; i++) {
    const { part } = toolResults[i];
    if (typeof part.content === "string" && part.content.length > 100) {
      part.content = "[cleared]";
    }
  }
}

async function autoCompact(messages: Anthropic.MessageParam[]): Promise<Anthropic.MessageParam[]> {
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const transcriptPath = path.join(TRANSCRIPT_DIR, `transcript_${Math.floor(Date.now() / 1000)}.jsonl`);

  const writeStream = fs.createWriteStream(transcriptPath);
  for (const msg of messages) {
    writeStream.write(JSON.stringify(msg) + "\n");
  }
  writeStream.end();

  const convText = JSON.stringify(messages).slice(0, 80000);
  const resp = await client.messages.create({
    model: MODEL,
    messages: [{ role: "user", content: `Summarize for continuity:\n${convText}` }],
    max_tokens: 2000,
  });

  const textBlock = resp.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  const summary = textBlock?.text || "";

  return [
    { role: "user", content: `[Compressed. Transcript: ${transcriptPath}]\n${summary}` },
    { role: "assistant", content: "Understood. Continuing with summary context." },
  ];
}

// ============================================================================
// TaskManager (s07)
// ============================================================================

class TaskManager {
  constructor() {
    fs.mkdirSync(TASKS_DIR, { recursive: true });
  }

  private nextId(): number {
    const files = fs.readdirSync(TASKS_DIR).filter((f) => f.match(/task_\d+\.json/));
    const ids = files.map((f) => parseInt(f.match(/task_(\d+)\.json/)?.[1] || "0", 10));
    return ids.length > 0 ? Math.max(...ids) + 1 : 1;
  }

  private load(taskId: number): Task {
    const taskPath = path.join(TASKS_DIR, `task_${taskId}.json`);
    if (!fs.existsSync(taskPath)) {
      throw new Error(`Task ${taskId} not found`);
    }
    return JSON.parse(fs.readFileSync(taskPath, "utf-8"));
  }

  private save(task: Task): void {
    fs.writeFileSync(path.join(TASKS_DIR, `task_${task.id}.json`), JSON.stringify(task, null, 2));
  }

  create(subject: string, description: string = ""): string {
    const task: Task = {
      id: this.nextId(),
      subject,
      description,
      status: "pending",
      owner: undefined,
      blockedBy: [],
      blocks: [],
    };
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  get(taskId: number): string {
    return JSON.stringify(this.load(taskId), null, 2);
  }

  update(taskId: number, status?: string, addBlockedBy?: number[], addBlocks?: number[]): string {
    const task = this.load(taskId);

    if (status) {
      task.status = status as Task["status"];

      if (status === "completed") {
        // Remove this task from blockedBy of other tasks
        const files = fs.readdirSync(TASKS_DIR).filter((f) => f.match(/task_\d+\.json/));
        for (const file of files) {
          const otherTask: Task = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file), "utf-8"));
          if (otherTask.blockedBy?.includes(taskId)) {
            otherTask.blockedBy = otherTask.blockedBy.filter((id) => id !== taskId);
            this.save(otherTask);
          }
        }
      }

      if (status === "deleted") {
        fs.unlinkSync(path.join(TASKS_DIR, `task_${taskId}.json`));
        return `Task ${taskId} deleted`;
      }
    }

    if (addBlockedBy) {
      task.blockedBy = [...new Set([...(task.blockedBy || []), ...addBlockedBy])];
    }
    if (addBlocks) {
      task.blocks = [...new Set([...(task.blocks || []), ...addBlocks])];
    }

    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  listAll(): string {
    const files = fs.readdirSync(TASKS_DIR).filter((f) => f.match(/task_\d+\.json/)).sort();
    const tasks: Task[] = files.map((f) => JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), "utf-8")));

    if (tasks.length === 0) return "No tasks.";

    const lines: string[] = [];
    for (const t of tasks) {
      const m = { pending: "[ ]", in_progress: "[>]", completed: "[x]" }[t.status] || "[?]";
      const owner = t.owner ? ` @${t.owner}` : "";
      const blocked = t.blockedBy && t.blockedBy.length > 0 ? ` (blocked by: ${t.blockedBy.join(", ")})` : "";
      lines.push(`${m} #${t.id}: ${t.subject}${owner}${blocked}`);
    }
    return lines.join("\n");
  }

  claim(taskId: number, owner: string): string {
    const task = this.load(taskId);
    task.owner = owner;
    task.status = "in_progress";
    this.save(task);
    return `Claimed task #${taskId} for ${owner}`;
  }
}

// ============================================================================
// BackgroundManager (s08)
// ============================================================================

class BackgroundManager {
  private tasks: Map<string, BackgroundTask> = new Map();
  private notifications: BackgroundNotification[] = [];

  run(command: string, timeout: number = 120): string {
    const taskId = uuid.v4().slice(0, 8);
    this.tasks.set(taskId, { status: "running", command });

    // Run in background using async
    this.execAsync(taskId, command, timeout);

    return `Background task ${taskId} started: ${command.slice(0, 80)}`;
  }

  private async execAsync(taskId: string, command: string, timeout: number): Promise<void> {
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: WORKDIR,
        timeout: timeout * 1000,
        maxBuffer: 50 * 1024 * 1024,
      });
      const output = (stdout + stderr).trim().slice(0, 50000);
      this.tasks.set(taskId, { status: "completed", command, result: output || "(no output)" });
      this.notifications.push({
        task_id: taskId,
        status: "completed",
        result: output.slice(0, 500),
      });
    } catch (error: any) {
      const output = (error.stdout || "") + (error.stderr || "") || error.message;
      this.tasks.set(taskId, { status: "error", command, result: output.slice(0, 50000) });
      this.notifications.push({
        task_id: taskId,
        status: "error",
        result: output.slice(0, 500),
      });
    }
  }

  check(taskId?: string): string {
    if (taskId) {
      const task = this.tasks.get(taskId);
      if (!task) return `Unknown: ${taskId}`;
      return `[${task.status}] ${task.result || "(running)"}`;
    }

    const lines: string[] = [];
    for (const [id, task] of this.tasks) {
      lines.push(`${id}: [${task.status}] ${task.command.slice(0, 60)}`);
    }
    return lines.join("\n") || "No bg tasks.";
  }

  drain(): BackgroundNotification[] {
    const notifs = [...this.notifications];
    this.notifications = [];
    return notifs;
  }
}

// ============================================================================
// MessageBus (s09)
// ============================================================================

class MessageBus {
  constructor() {
    fs.mkdirSync(INBOX_DIR, { recursive: true });
  }

  send(sender: string, to: string, content: string, msgType: string = "message", extra?: Record<string, any>): string {
    const msg: Message = {
      type: msgType,
      from: sender,
      content,
      timestamp: Date.now() / 1000,
      ...extra,
    };
    fs.appendFileSync(path.join(INBOX_DIR, `${to}.jsonl`), JSON.stringify(msg) + "\n");
    return `Sent ${msgType} to ${to}`;
  }

  readInbox(name: string): Message[] {
    const inboxPath = path.join(INBOX_DIR, `${name}.jsonl`);
    if (!fs.existsSync(inboxPath)) return [];

    const content = fs.readFileSync(inboxPath, "utf-8");
    const msgs: Message[] = content
      .trim()
      .split("\n")
      .filter((l) => l)
      .map((l) => JSON.parse(l));
    fs.writeFileSync(inboxPath, "");
    return msgs;
  }

  broadcast(sender: string, content: string, names: string[]): string {
    let count = 0;
    for (const name of names) {
      if (name !== sender) {
        this.send(sender, name, content, "broadcast");
        count++;
      }
    }
    return `Broadcast to ${count} teammates`;
  }
}

// ============================================================================
// TeammateManager (s09/s11)
// ============================================================================

class TeammateManager {
  private configPath: string;
  private config: TeamConfig;
  private running: Map<string, boolean> = new Map();

  constructor(private bus: MessageBus, private taskMgr: TaskManager) {
    fs.mkdirSync(TEAM_DIR, { recursive: true });
    this.configPath = path.join(TEAM_DIR, "config.json");
    this.config = this.load();
  }

  private load(): TeamConfig {
    if (fs.existsSync(this.configPath)) {
      return JSON.parse(fs.readFileSync(this.configPath, "utf-8"));
    }
    return { team_name: "default", members: [] };
  }

  private save(): void {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  private find(name: string): TeamMember | undefined {
    return this.config.members.find((m) => m.name === name);
  }

  spawn(name: string, role: string, prompt: string): string {
    const member = this.find(name);
    if (member) {
      if (member.status !== "idle" && member.status !== "shutdown") {
        return `Error: '${name}' is currently ${member.status}`;
      }
      member.status = "working";
      member.role = role;
    } else {
      this.config.members.push({ name, role, status: "working" });
    }
    this.save();

    this.running.set(name, true);
    this.loop(name, role, prompt);

    return `Spawned '${name}' (role: ${role})`;
  }

  private setStatus(name: string, status: TeamMember["status"]): void {
    const member = this.find(name);
    if (member) {
      member.status = status;
      this.save();
    }
  }

  private async loop(name: string, role: string, prompt: string): Promise<void> {
    const teamName = this.config.team_name;
    const sysPrompt = `You are '${name}', role: ${role}, team: ${teamName}, at ${WORKDIR}. Use idle when done with current work. You may auto-claim tasks.`;

    const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
    const tools: Anthropic.Tool[] = [
      { name: "bash", description: "Run command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
      { name: "read_file", description: "Read file.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "write_file", description: "Write file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
      { name: "edit_file", description: "Edit file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
      { name: "send_message", description: "Send message.", input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" } }, required: ["to", "content"] } },
      { name: "idle", description: "Signal no more work.", input_schema: { type: "object", properties: {} } },
      { name: "claim_task", description: "Claim task by ID.", input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
    ];

    while (this.running.get(name)) {
      // -- WORK PHASE --
      for (let i = 0; i < 50 && this.running.get(name); i++) {
        const inbox = this.bus.readInbox(name);
        for (const msg of inbox) {
          if (msg.type === "shutdown_request") {
            this.setStatus(name, "shutdown");
            this.running.set(name, false);
            return;
          }
          messages.push({ role: "user", content: JSON.stringify(msg) });
        }

        try {
          const response = await client.messages.create({
            model: MODEL,
            system: sysPrompt,
            messages,
            tools,
            max_tokens: 8000,
          });

          messages.push({ role: "assistant", content: response.content });

          if (response.stop_reason !== "tool_use") break;

          const results: Anthropic.ToolResultBlockParam[] = [];
          let idleRequested = false;

          for (const block of response.content) {
            if (block.type === "tool_use") {
              let output: string;

              if (block.name === "idle") {
                idleRequested = true;
                output = "Entering idle phase.";
              } else if (block.name === "claim_task") {
                output = this.taskMgr.claim((block.input as any).task_id, name);
              } else if (block.name === "send_message") {
                const input = block.input as any;
                output = this.bus.send(name, input.to, input.content);
              } else {
                const dispatch: Record<string, (args: any) => string> = {
                  bash: (args) => runBash(args.command),
                  read_file: (args) => runRead(args.path),
                  write_file: (args) => runWrite(args.path, args.content),
                  edit_file: (args) => runEdit(args.path, args.old_text, args.new_text),
                };
                output = dispatch[block.name]?.(block.input as any) || "Unknown";
              }

              console.log(`  [${name}] ${block.name}: ${output.slice(0, 120)}`);
              results.push({ type: "tool_result", tool_use_id: block.id, content: output });
            }
          }

          messages.push({ role: "user", content: results });
          if (idleRequested) break;
        } catch {
          this.setStatus(name, "shutdown");
          return;
        }
      }

      if (!this.running.get(name)) return;

      // -- IDLE PHASE --
      this.setStatus(name, "idle");
      let resume = false;

      for (let i = 0; i < Math.floor(IDLE_TIMEOUT / Math.max(POLL_INTERVAL, 1)) && this.running.get(name); i++) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL * 1000));

        const inbox = this.bus.readInbox(name);
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

        // Check for unclaimed tasks
        const unclaimed: Task[] = [];
        const files = fs.readdirSync(TASKS_DIR).filter((f) => f.match(/task_\d+\.json/)).sort();
        for (const file of files) {
          const t: Task = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file), "utf-8"));
          if (t.status === "pending" && !t.owner && (!t.blockedBy || t.blockedBy.length === 0)) {
            unclaimed.push(t);
          }
        }

        if (unclaimed.length > 0) {
          const task = unclaimed[0];
          this.taskMgr.claim(task.id, name);

          // Identity re-injection
          if (messages.length <= 3) {
            messages.unshift({
              role: "user",
              content: `<identity>You are '${name}', role: ${role}, team: ${teamName}.</identity>`,
            });
            messages.splice(1, 0, { role: "assistant", content: `I am ${name}. Continuing.` });
          }

          messages.push({
            role: "user",
            content: `<auto-claimed>Task #${task.id}: ${task.subject}\n${task.description || ""}</auto-claimed>`,
          });
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

  listAll(): string {
    if (this.config.members.length === 0) return "No teammates.";
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
// Global instances
// ============================================================================

const TODO = new TodoManager();
const SKILLS = new SkillLoader(SKILLS_DIR);
const TASK_MGR = new TaskManager();
const BG = new BackgroundManager();
const BUS = new MessageBus();
const TEAM = new TeammateManager(BUS, TASK_MGR);

// ============================================================================
// System prompt
// ============================================================================

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.
Prefer task_create/task_update/task_list for multi-step work. Use TodoWrite for short checklists.
Use task for subagent delegation. Use load_skill for specialized knowledge.
Skills: ${SKILLS.descriptions()}`;

// ============================================================================
// Shutdown protocol (s10)
// ============================================================================

function handleShutdownRequest(teammate: string): string {
  const reqId = uuid.v4().slice(0, 8);
  shutdownRequests[reqId] = { target: teammate, status: "pending" };
  BUS.send("lead", teammate, "Please shut down.", "shutdown_request", { request_id: reqId });
  return `Shutdown request ${reqId} sent to '${teammate}'`;
}

// ============================================================================
// Plan approval (s10)
// ============================================================================

function handlePlanReview(requestId: string, approve: boolean, feedback: string = ""): string {
  const req = planRequests[requestId];
  if (!req) return `Error: Unknown plan request_id '${requestId}'`;
  req.status = approve ? "approved" : "rejected";
  BUS.send("lead", req.from, feedback, "plan_approval_response", { request_id: requestId, approve, feedback });
  return `Plan ${req.status} for '${req.from}'`;
}

// ============================================================================
// Tool dispatch (s02)
// ============================================================================

const TOOL_HANDLERS: Record<string, (args: Record<string, any>) => string | Promise<string>> = {
  bash: (args) => runBash(args.command),
  read_file: (args) => runRead(args.path, args.limit),
  write_file: (args) => runWrite(args.path, args.content),
  edit_file: (args) => runEdit(args.path, args.old_text, args.new_text),
  TodoWrite: (args) => TODO.update(args.items),
  task: (args) => runSubagent(args.prompt, args.agent_type || "Explore"),
  load_skill: (args) => SKILLS.load(args.name),
  compress: () => "Compressing...",
  background_run: (args) => BG.run(args.command, args.timeout || 120),
  check_background: (args) => BG.check(args.task_id),
  task_create: (args) => TASK_MGR.create(args.subject, args.description || ""),
  task_get: (args) => TASK_MGR.get(args.task_id),
  task_update: (args) => TASK_MGR.update(args.task_id, args.status, args.add_blocked_by, args.add_blocks),
  task_list: () => TASK_MGR.listAll(),
  spawn_teammate: (args) => TEAM.spawn(args.name, args.role, args.prompt),
  list_teammates: () => TEAM.listAll(),
  send_message: (args) => BUS.send("lead", args.to, args.content, args.msg_type || "message"),
  read_inbox: () => JSON.stringify(BUS.readInbox("lead"), null, 2),
  broadcast: (args) => BUS.broadcast("lead", args.content, TEAM.memberNames()),
  shutdown_request: (args) => handleShutdownRequest(args.teammate),
  plan_approval: (args) => handlePlanReview(args.request_id, args.approve, args.feedback || ""),
  idle: () => "Lead does not idle.",
  claim_task: (args) => TASK_MGR.claim(args.task_id, "lead"),
};

const TOOLS: Anthropic.Tool[] = [
  { name: "bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.", input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "TodoWrite", description: "Update task tracking list.", input_schema: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] }, activeForm: { type: "string" } }, required: ["content", "status", "activeForm"] } } }, required: ["items"] } },
  { name: "task", description: "Spawn a subagent for isolated exploration or work.", input_schema: { type: "object", properties: { prompt: { type: "string" }, agent_type: { type: "string", enum: ["Explore", "general-purpose"] } }, required: ["prompt"] } },
  { name: "load_skill", description: "Load specialized knowledge by name.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "compress", description: "Manually compress conversation context.", input_schema: { type: "object", properties: {} } },
  { name: "background_run", description: "Run command in background thread.", input_schema: { type: "object", properties: { command: { type: "string" }, timeout: { type: "integer" } }, required: ["command"] } },
  { name: "check_background", description: "Check background task status.", input_schema: { type: "object", properties: { task_id: { type: "string" } } } },
  { name: "task_create", description: "Create a persistent file task.", input_schema: { type: "object", properties: { subject: { type: "string" }, description: { type: "string" } }, required: ["subject"] } },
  { name: "task_get", description: "Get task details by ID.", input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
  { name: "task_update", description: "Update task status or dependencies.", input_schema: { type: "object", properties: { task_id: { type: "integer" }, status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"] }, add_blocked_by: { type: "array", items: { type: "integer" } }, add_blocks: { type: "array", items: { type: "integer" } } }, required: ["task_id"] } },
  { name: "task_list", description: "List all tasks.", input_schema: { type: "object", properties: {} } },
  { name: "spawn_teammate", description: "Spawn a persistent autonomous teammate.", input_schema: { type: "object", properties: { name: { type: "string" }, role: { type: "string" }, prompt: { type: "string" } }, required: ["name", "role", "prompt"] } },
  { name: "list_teammates", description: "List all teammates.", input_schema: { type: "object", properties: {} } },
  { name: "send_message", description: "Send a message to a teammate.", input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string", enum: VALID_MSG_TYPES } }, required: ["to", "content"] } },
  { name: "read_inbox", description: "Read and drain the lead's inbox.", input_schema: { type: "object", properties: {} } },
  { name: "broadcast", description: "Send message to all teammates.", input_schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] } },
  { name: "shutdown_request", description: "Request a teammate to shut down.", input_schema: { type: "object", properties: { teammate: { type: "string" } }, required: ["teammate"] } },
  { name: "plan_approval", description: "Approve or reject a teammate's plan.", input_schema: { type: "object", properties: { request_id: { type: "string" }, approve: { type: "boolean" }, feedback: { type: "string" } }, required: ["request_id", "approve"] } },
  { name: "idle", description: "Enter idle state.", input_schema: { type: "object", properties: {} } },
  { name: "claim_task", description: "Claim a task from the board.", input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
];

// ============================================================================
// Agent Loop
// ============================================================================

async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  let roundsWithoutTodo = 0;

  while (true) {
    // s06: compression pipeline
    microcompact(messages);
    if (estimateTokens(messages) > TOKEN_THRESHOLD) {
      console.log("[auto-compact triggered]");
      const compacted = await autoCompact(messages);
      messages.length = 0;
      messages.push(...compacted);
    }

    // s08: drain background notifications
    const notifs = BG.drain();
    if (notifs.length > 0) {
      const txt = notifs.map((n) => `[bg:${n.task_id}] ${n.status}: ${n.result}`).join("\n");
      messages.push({ role: "user", content: `<background-results>\n${txt}\n</background-results>` });
      messages.push({ role: "assistant", content: "Noted background results." });
    }

    // s10: check lead inbox
    const inbox = BUS.readInbox("lead");
    if (inbox.length > 0) {
      messages.push({ role: "user", content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>` });
      messages.push({ role: "assistant", content: "Noted inbox messages." });
    }

    // LLM call
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

    // Tool execution
    const results: Anthropic.ToolResultBlockParam[] = [];
    let usedTodo = false;
    let manualCompress = false;

    for (const block of response.content) {
      if (block.type === "tool_use") {
        if (block.name === "compress") {
          manualCompress = true;
        }

        const handler = TOOL_HANDLERS[block.name];
        let output: string;

        try {
          const result = handler ? handler(block.input as Record<string, any>) : `Unknown tool: ${block.name}`;
          output = result instanceof Promise ? await result : result;
        } catch (error: any) {
          output = `Error: ${error.message}`;
        }

        console.log(`> ${block.name}: ${output.slice(0, 200)}`);
        results.push({ type: "tool_result", tool_use_id: block.id, content: output });

        if (block.name === "TodoWrite") {
          usedTodo = true;
        }
      }
    }

    // s03: nag reminder
    roundsWithoutTodo = usedTodo ? 0 : roundsWithoutTodo + 1;
    if (TODO.hasOpenItems() && roundsWithoutTodo >= 3) {
      results.unshift({ type: "text", text: "<reminder>Update your todos.</reminder>" } as any);
    }

    messages.push({ role: "user", content: results });

    // s06: manual compress
    if (manualCompress) {
      console.log("[manual compact]");
      const compacted = await autoCompact(messages);
      messages.length = 0;
      messages.push(...compacted);
    }
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
  console.log("\n🤖 s_full - Full Reference Agent (TypeScript)");
  console.log("==============================================\n");

  const history: Anthropic.MessageParam[] = [];

  while (true) {
    try {
      const query = await askQuestion("\x1b[36ms_full >> \x1b[0m");

      if (query.trim().toLowerCase() === "q" || query.trim().toLowerCase() === "exit" || query.trim() === "") {
        TEAM.stopAll();
        break;
      }

      if (query.trim() === "/compact") {
        if (history.length > 0) {
          console.log("[manual compact via /compact]");
          const compacted = await autoCompact(history);
          history.length = 0;
          history.push(...compacted);
        }
        continue;
      }

      if (query.trim() === "/tasks") {
        console.log(TASK_MGR.listAll());
        continue;
      }

      if (query.trim() === "/team") {
        console.log(TEAM.listAll());
        continue;
      }

      if (query.trim() === "/inbox") {
        console.log(JSON.stringify(BUS.readInbox("lead"), null, 2));
        continue;
      }

      history.push({ role: "user", content: query });
      await agentLoop(history);
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
