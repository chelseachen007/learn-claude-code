/**
 * s05_skill_loading.ts - Skills (TypeScript 版本)
 *
 * Two-layer skill injection that avoids bloating the system prompt:
 *
 *     Layer 1 (cheap): skill names in system prompt (~100 tokens/skill)
 *     Layer 2 (on demand): full skill body in tool_result
 *
 *     skills/
 *       pdf/
 *         SKILL.md          <-- frontmatter (name, description) + body
 *       code-review/
 *         SKILL.md
 *
 *     System prompt:
 *     +--------------------------------------+
 *     | You are a coding agent.              |
 *     | Skills available:                    |
 *     |   - pdf: Process PDF files...        |  <-- Layer 1: metadata only
 *     |   - code-review: Review code...      |
 *     +--------------------------------------+
 *
 *     When model calls load_skill("pdf"):
 *     +--------------------------------------+
 *     | tool_result:                         |
 *     | <skill>                              |
 *     |   Full PDF processing instructions   |  <-- Layer 2: full body
 *     |   Step 1: ...                        |
 *     |   Step 2: ...                        |
 *     | </skill>                             |
 *     +--------------------------------------+
 *
 * Key insight: "Don't put everything in the system prompt. Load on demand."
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
const SKILLS_DIR = path.join(WORKDIR, "skills");

// ============================================================================
// 类型定义
// ============================================================================

interface SkillMeta {
  name?: string;
  description?: string;
  tags?: string;
  [key: string]: string | undefined;
}

interface Skill {
  meta: SkillMeta;
  body: string;
  path: string;
}

// ============================================================================
// SkillLoader: 扫描 skills/<name>/SKILL.md 并解析 YAML frontmatter
// ============================================================================

class SkillLoader {
  private skillsDir: string;
  private skills: Map<string, Skill> = new Map();

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
    this.loadAll();
  }

  private loadAll(): void {
    if (!fs.existsSync(this.skillsDir)) {
      return;
    }

    const skillFiles = this.findSkillFiles(this.skillsDir);

    for (const filePath of skillFiles.sort()) {
      const text = fs.readFileSync(filePath, "utf-8");
      const { meta, body } = this.parseFrontmatter(text);
      const name = meta.name || path.basename(path.dirname(filePath));
      this.skills.set(name, {
        meta,
        body,
        path: filePath,
      });
    }
  }

  private findSkillFiles(dir: string): string[] {
    const results: string[] = [];

    const scan = (currentDir: string) => {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath);
        } else if (entry.name === "SKILL.md") {
          results.push(fullPath);
        }
      }
    };

    scan(dir);
    return results;
  }

  private parseFrontmatter(text: string): { meta: SkillMeta; body: string } {
    const match = text.match(/^---\n(.*?)\n---\n(.*)/s);
    if (!match) {
      return { meta: {}, body: text.trim() };
    }

    const meta: SkillMeta = {};
    for (const line of match[1].trim().split("\n")) {
      const colonIndex = line.indexOf(":");
      if (colonIndex !== -1) {
        const key = line.slice(0, colonIndex).trim();
        const value = line.slice(colonIndex + 1).trim();
        meta[key] = value;
      }
    }

    return { meta, body: match[2].trim() };
  }

  /**
   * Layer 1: short descriptions for the system prompt.
   */
  getDescriptions(): string {
    if (this.skills.size === 0) {
      return "(no skills available)";
    }

    const lines: string[] = [];
    for (const [name, skill] of this.skills) {
      const desc = skill.meta.description || "No description";
      const tags = skill.meta.tags || "";
      let line = `  - ${name}: ${desc}`;
      if (tags) {
        line += ` [${tags}]`;
      }
      lines.push(line);
    }
    return lines.join("\n");
  }

  /**
   * Layer 2: full skill body returned in tool_result.
   */
  getContent(name: string): string {
    const skill = this.skills.get(name);
    if (!skill) {
      const available = Array.from(this.skills.keys()).join(", ");
      return `Error: Unknown skill '${name}'. Available: ${available}`;
    }
    return `<skill name="${name}">\n${skill.body}\n</skill>`;
  }
}

// ============================================================================
// 初始化
// ============================================================================

const SKILL_LOADER = new SkillLoader(SKILLS_DIR);

// Layer 1: skill metadata injected into system prompt
const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use load_skill to access specialized knowledge before tackling unfamiliar topics.

Skills available:
${SKILL_LOADER.getDescriptions()}`;

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
    name: "load_skill",
    description: "Load specialized knowledge by name.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name to load" },
      },
      required: ["name"],
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
  name?: string;
}

const TOOL_HANDLERS: Record<string, (input: ToolInput) => string> = {
  bash: (input) => runBash(input.command!),
  read_file: (input) => runRead(input.path!, input.limit),
  write_file: (input) => runWrite(input.path!, input.content!),
  edit_file: (input) => runEdit(input.path!, input.old_text!, input.new_text!),
  load_skill: (input) => SKILL_LOADER.getContent(input.name!),
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
          output = handler ? handler(block.input as ToolInput) : `Unknown tool: ${block.name}`;
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
  console.log("\n🤖 s05 Skill Loading (TypeScript)");
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
      query = await askQuestion("\x1b[36ms05 >> \x1b[0m");
    } catch (error) {
      break;
    }

    if (query.trim().toLowerCase() === "q" || query.trim().toLowerCase() === "exit" || query.trim() === "") {
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
