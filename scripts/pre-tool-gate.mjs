#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  bearerAuthorization,
  readAuthToken,
  readWorkspaceBinding
} from "../packages/local-auth/src/index.js";
import {
  DEFAULT_TIMEOUT_MS,
  readInput,
  verifyEventEndpointIdentity
} from "./hook-event.mjs";

const DIRECT_WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
const SAFE_AGENT_TYPES = new Set(["Explore", "Plan"]);
const MUTATION_NAME = /(?:^|__|_)(?:apply|commit|create|delete|deploy|edit|merge|move|patch|publish|push|remove|rename|send|update|upload|write)(?:__|_|$)/iu;
const SAFE_SHELL_PREFIX = /^(?:cat|clang-uml|cmake|ctest|find|git\s+(?:diff|grep|log|ls-files|rev-parse|show|status)|grep|head|ls|make|ninja|pnpm\s+(?:check|facts|facts-diff|intentcanvas|test)|pwd|rg|sed\s+-n|stat|tail|wc)\b/u;
const BUNDLED_PLANNING_TOOL = /^node\s+["']?(?:[^"'\r\n]*[/\\])?(?:intentcanvas|code-facts|plan-diff|facts-diff)\.mjs["']?(?:\s|$)/u;
const WORKSPACE_REBIND_COMMAND = /(?:pnpm\s+intentcanvas|intentcanvas\.mjs)["']?\s+plan\s+(?:detach|import|open)\b/u;
const SHELL_MUTATION = /(?:^|[;&|]\s*)(?:cp|dd|git\s+(?:add|cherry-pick|commit|merge|push|rebase|reset|restore|switch)|install|mkdir|mv|rm|rmdir|tee|touch|truncate)\b|(?:^|\s)(?:>|>>)(?:\s|$)|\bsed\s+-i\b|\bperl\s+-pi\b/iu;

function hasShellComposition(command) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (character === "'" || character === "\"") {
      if (quote === character) quote = null;
      else if (quote === null) quote = character;
      continue;
    }
    if (quote === "'") continue;
    if (character === "`" || character === "\n" || character === "\r" ||
        (character === "$" && command[index + 1] === "(")) return true;
    if (quote === null && [";", "|", "&"].includes(character)) return true;
  }
  return quote !== null || escaped;
}

export function toolCanWrite(input) {
  const toolName = typeof input?.tool_name === "string" ? input.tool_name : "";
  if (DIRECT_WRITE_TOOLS.has(toolName)) return true;
  if (toolName === "Agent") {
    return !SAFE_AGENT_TYPES.has(input?.tool_input?.subagent_type);
  }
  if (toolName === "Bash") {
    const command = typeof input?.tool_input?.command === "string"
      ? input.tool_input.command.trim()
      : "";
    if (!command) return true;
    if (SHELL_MUTATION.test(command)) return true;
    if (WORKSPACE_REBIND_COMMAND.test(command)) return true;
    if (hasShellComposition(command)) return true;
    return !SAFE_SHELL_PREFIX.test(command) && !BUNDLED_PLANNING_TOOL.test(command);
  }
  if (toolName.startsWith("mcp__")) return MUTATION_NAME.test(toolName);
  return false;
}

function deny(reason) {
  return {
    allowed: false,
    output: {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason
      }
    }
  };
}

async function readSmallJson(response, maxBytes = 64 * 1024) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("response too large");
  const text = await response.text();
  if (Buffer.byteLength(text) > maxBytes) throw new Error("response too large");
  return JSON.parse(text);
}

export async function checkPreToolGate(input, {
  env = process.env,
  home,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  timeoutSignal = AbortSignal.timeout,
  readBinding = readWorkspaceBinding,
  readToken = readAuthToken,
  verifyIdentity = verifyEventEndpointIdentity
} = {}) {
  if (!toolCanWrite(input)) return { allowed: true };

  const cwd = typeof input?.cwd === "string" && input.cwd.trim()
    ? input.cwd
    : process.cwd();
  let binding;
  try {
    binding = await readBinding(cwd, { home });
  } catch {
    return deny("IntentCanvas 的工作区审批绑定损坏，已阻止写入；请重新导入可视化计划。");
  }
  if (!binding) return { allowed: true };

  const token = await readToken({ env, home }).catch(() => null);
  if (!token) {
    return deny("IntentCanvas 找不到本地审批凭据，已阻止写入；请先启动 Runtime。");
  }

  const endpoint = new URL("/api/events", binding.runtimeUrl);
  const identityOk = await verifyIdentity(endpoint, token, { timeout: timeoutMs }).catch(() => false);
  if (!identityOk) {
    return deny("本地端口无法证明是当前用户的 IntentCanvas Runtime，已阻止写入。");
  }

  let response;
  try {
    response = await fetchImpl(
      `${binding.runtimeUrl}/api/reviews/${encodeURIComponent(binding.reviewId)}/gate`,
      {
        redirect: "error",
        signal: timeoutSignal(timeoutMs),
        headers: {
          Accept: "application/json",
          Authorization: bearerAuthorization(token)
        }
      }
    );
    const gate = await readSmallJson(response);
    if (response.ok && gate?.reviewId === binding.reviewId && gate?.allowed === true &&
        gate?.status === "approved" && Number.isInteger(gate?.revision)) {
      return { allowed: true, reviewId: binding.reviewId, revision: gate.revision };
    }
    const status = typeof gate?.status === "string" ? gate.status : "不可用";
    return deny(`可视化计划 ${binding.reviewId} 尚未全部批准（当前状态：${status}），已阻止写入。`);
  } catch {
    return deny("无法读取 IntentCanvas 审批状态，已按安全策略阻止写入。");
  }
}

export async function main(options = {}) {
  const input = await readInput(options.stdin ?? process.stdin);
  if (!input) return 0;
  const result = await checkPreToolGate(input, options);
  if (!result.allowed) {
    (options.stdout ?? process.stdout).write(`${JSON.stringify(result.output)}\n`);
  }
  return 0;
}

const invokedAsScript = process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedAsScript) await main().catch(() => {
  process.stdout.write(`${JSON.stringify(deny(
    "IntentCanvas 审批门禁发生错误，已阻止写入。"
  ).output)}\n`);
});
