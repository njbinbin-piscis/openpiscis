import type { BuiltinToolInfo } from "../services/tauri";

export type SkillMarketSource = "anthropic-official" | "openai-curated";

export interface SkillAdaptationTarget {
  market: SkillMarketSource;
  bundleName: string;
  bundleDescription?: string;
  skillNames: string[];
  sourcePath?: string;
  sourceTag: string;
}

function formatToolSurface(tools: BuiltinToolInfo[]): string {
  return tools
    .map((t) => `- ${t.name}${t.windows_only ? " (Windows)" : ""}: ${t.description}`)
    .join("\n");
}

export function buildSkillAdaptationPrompt(
  target: SkillAdaptationTarget,
  tools: BuiltinToolInfo[],
  language: "zh" | "en",
): string {
  const skillList = target.skillNames.map((s) => `- ${s}`).join("\n");
  const toolSurface = formatToolSurface(tools);
  const marketLabel =
    target.market === "anthropic-official"
      ? language === "zh"
        ? "Anthropic 官方插件市场"
        : "Anthropic official plugin market"
      : language === "zh"
        ? "OpenAI Curated 技能市场"
        : "OpenAI curated skills market";

  if (language === "zh") {
    return `请作为 Piscis 技能适配工程师，对以下来自「${marketLabel}」的技能包进行全面兼容性检查与适应性改写，并直接开始执行（无需等待我确认）。

## 技能包
- 来源标记：\`${target.sourceTag}\`
- 名称：${target.bundleName}
${target.bundleDescription ? `- 说明：${target.bundleDescription}` : ""}
${target.sourcePath ? `- 仓库路径：${target.sourcePath}` : ""}
- 待处理技能：
${skillList}

## 你的任务
1. 使用 \`skill_list\` 查看当前已安装技能，定位上述技能（config 中 source / lifecycle 对应 \`${target.sourceTag}\`）。若尚未安装，先明确提示用户返回技能页点击「安装」后再继续。
2. 逐个读取对应 SKILL.md 及附属 scripts/references（如有）。
3. 对照下方「Piscis 可用工具面」，检查每个技能引用的工具、CLI、平台假设、外部 API 是否与本机 Piscis 桌面环境兼容。
4. 输出问题清单：工具缺失、平台不符、依赖未满足、Codex/ChatGPT/Claude Code 特有流程无法复现等。
5. 使用 \`skill_manage\` 对每个技能做适应性改写：保留业务意图，将步骤映射到 Piscis 已有工具；补充 Windows/桌面说明；删除不可执行步骤；更新 frontmatter 的 \`tools\` 字段。
6. 用 \`plan_todo\` 跟踪「检查 → 改写 → 验收」进度；完成后给出简短验收清单（已修复项 + 仍需用户手动配置项）。

## Piscis 可用工具面（当前实例）
${toolSurface}

## 约束
- 不要删除技能；优先 patch 改写。仅当完全无法适配时才建议卸载并说明原因。
- 改写后的 SKILL.md 必须符合 Piscis skill_manage 格式（frontmatter 含 name、description、tools 等）。
- 不要编造本机不存在的工具或 MCP；缺失能力须在验收清单中明确标注。`;
  }

  return `Act as a Piscis skill adaptation engineer. Perform a full compatibility review and adaptive rewrite for the following bundle from the **${marketLabel}**, then start executing immediately (no need to wait for my confirmation).

## Bundle
- Source tag: \`${target.sourceTag}\`
- Name: ${target.bundleName}
${target.bundleDescription ? `- Description: ${target.bundleDescription}` : ""}
${target.sourcePath ? `- Repo path: ${target.sourcePath}` : ""}
- Skills to process:
${skillList}

## Your tasks
1. Use \`skill_list\` to locate installed skills matching source tag \`${target.sourceTag}\`. If missing, tell the user to install from the Skills market first, then stop.
2. Read each SKILL.md plus scripts/references when present.
3. Compare against the Piscis tool surface below; flag missing tools, platform mismatches, unmet dependencies, and Codex/ChatGPT/Claude Code-only flows.
4. Use \`skill_manage\` to adapt each skill: preserve intent, remap steps to Piscis tools, add desktop/Windows notes, remove impossible steps, update frontmatter \`tools\`.
5. Track progress with \`plan_todo\`; finish with a short acceptance checklist (fixed items + manual setup still required).

## Piscis tool surface (this instance)
${toolSurface}

## Constraints
- Do not delete skills unless truly unmappable; prefer patch rewrites.
- Output SKILL.md must remain valid for Piscis skill_manage.
- Do not invent tools or MCP servers that are not listed above.`;
}
