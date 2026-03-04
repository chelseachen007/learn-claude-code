/**
 * s01 - The Agent Loop (TypeScript 版本)
 *
 * 格言: "One loop & Bash is all you need"
 *
 * 这是最小的 Agent 实现:
 * - 一个 while 循环
 * - 一个 bash 工具
 * - 持续运行直到模型说"我完成了"
 */

import Anthropic from "@anthropic-ai/sdk";
import * as readline from "readline";
import { execSync } from "child_process";
import { config } from "dotenv";

// 加载 .env 文件（从父目录）
config({ path: "../.env" });

// ============================================================================
// 配置
// ============================================================================

const MODEL = process.env.MODEL_ID || "claude-sonnet-4-20250514";
const SYSTEM = `你是一个有帮助的 AI 助手，可以通过执行 bash 命令来帮助用户完成任务。
执行命令时要小心谨慎，确保命令安全后再执行。
完成任务后，用简洁的中文向用户报告结果。`;

// ============================================================================
// 工具定义
// ============================================================================

const BASH_TOOL: Anthropic.Tool = {
  name: "bash",
  description: "执行 bash 命令。可以安全地执行任何 shell 命令。",
  input_schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "要执行的 bash 命令",
      },
    },
    required: ["command"],
  },
};

const TOOLS = [BASH_TOOL];

// ============================================================================
// 工具处理器
// ============================================================================

function runBash(command: string): string {
  try {
    const output = execSync(command, {
      encoding: "utf-8",
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
    return output || "(无输出)";
  } catch (error: any) {
    return `错误: ${error.message}`;
  }
}

const TOOL_HANDLERS: Record<string, (input: any) => string> = {
  bash: (input) => runBash(input.command),
};

// ============================================================================
// Agent 循环 - 核心逻辑
// ============================================================================

async function agentLoop(
  client: Anthropic,
  messages: Anthropic.MessageParam[]
): Promise<string> {
  while (true) {
    // 1. 调用 LLM
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM,
      messages: messages,
      tools: TOOLS,
    });

    // 2. 将助手回复添加到消息历史
    messages.push({
      role: "assistant",
      content: response.content,
    });

    // 3. 检查是否需要调用工具
    if (response.stop_reason !== "tool_use") {
      // 模型决定停止，提取文本返回
      const textBlock = response.content.find(
        (block) => block.type === "text"
      ) as Anthropic.TextBlock | undefined;
      return textBlock?.text || "";
    }

    // 4. 执行工具调用
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type === "tool_use") {
        const toolName = block.name;
        const toolInput = block.input;
        const toolId = block.id;

        // 执行工具
        const output = TOOL_HANDLERS[toolName]?.(toolInput) || "未知工具";

        // 打印执行的命令（带颜色）
        if (toolName === "bash") {
          console.log(`\x1b[36ms01 >> \x1b[33m$ ${(toolInput as any).command}\x1b[0m`);
          console.log(output);
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolId,
          content: output,
        });
      }
    }

    // 5. 将工具结果返回给模型，继续循环
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
  console.log("\n🤖 s01 Agent Loop (TypeScript)");
  console.log("================================\n");

  // 初始化客户端
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.ANTHROPIC_BASE_URL,
  });

  // 获取用户输入
  const userInput = process.argv[2] || await askQuestion("请输入任务: ");

  // 初始化消息
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: userInput,
    },
  ];

  console.log(`\n用户: ${userInput}\n`);

  try {
    // 运行 Agent 循环
    const result = await agentLoop(client, messages);

    console.log("\n" + result);
    console.log("\n\x1b[36ms01 >>\x1b[0m ");
  } catch (error: any) {
    console.error("错误:", error.message);
  }
}

main();
