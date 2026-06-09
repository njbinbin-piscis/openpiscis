/**
 * Tauri IPC — config domain.
 *
 * User-facing configuration & registries: settings, memory, skills (+ ClawHub
 * bridge), Anthropic official plugins, MCP servers, builtin & user tool plugins, and audit log.
 *
 * Mirrors Rust-side `src-tauri/src/commands/config/*`.
 */
import { invoke } from "@tauri-apps/api/core";
import type { SessionArtifact } from "./chat";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface Settings {
  anthropic_api_key: string;
  openai_api_key: string;
  deepseek_api_key: string;
  qwen_api_key: string;
  minimax_api_key: string;
  zhipu_api_key: string;
  kimi_api_key: string;
  provider: string;
  model: string;
  custom_base_url: string;
  workspace_root: string;
  allow_outside_workspace: boolean;
  language: string;
  max_tokens: number;
  /** Context window size in tokens (input limit). 0 = auto. */
  context_window: number;
  confirm_shell_commands: boolean;
  confirm_file_writes: boolean;
  browser_headless: boolean;
  is_configured?: boolean;
  // IM Gateway
  feishu_app_id: string;
  feishu_app_secret: string;
  feishu_domain: string;
  feishu_enabled: boolean;
  wecom_bot_id: string;
  wecom_bot_secret: string;
  wecom_enabled: boolean;
  dingtalk_app_key: string;
  dingtalk_app_secret: string;
  dingtalk_robot_code: string;
  dingtalk_corp_id: string;
  dingtalk_agent_id: string;
  dingtalk_mcp_url: string;
  dingtalk_enabled: boolean;
  telegram_bot_token: string;
  telegram_enabled: boolean;
  // Slack
  slack_webhook_url: string;
  slack_enabled: boolean;
  // Discord
  discord_webhook_url: string;
  discord_enabled: boolean;
  // Microsoft Teams
  teams_webhook_url: string;
  teams_enabled: boolean;
  // Matrix
  matrix_homeserver: string;
  matrix_access_token: string;
  matrix_room_id: string;
  matrix_enabled: boolean;
  // Generic Webhook
  webhook_outbound_url: string;
  webhook_auth_token: string;
  webhook_enabled: boolean;
  // WeChat (iLink Bot HTTP server)
  wechat_enabled: boolean;
  wechat_gateway_token: string;
  wechat_gateway_port: number;
  wechat_bot_token: string;
  wechat_base_url: string;
  wechat_bot_id: string;
  /** When true, inbound IM messages switch the app into minimal overlay mode. */
  im_auto_minimal_mode: boolean;
  /** IM message handling mode: "queue" or "cancel". */
  im_message_mode: string;
  // Email (SMTP / IMAP)
  smtp_host: string;
  smtp_port: number;
  smtp_username: string;
  smtp_password: string;
  imap_host: string;
  imap_port: number;
  smtp_from_name: string;
  email_enabled: boolean;
  // User tool configs (tool_name → { field: value })
  user_tool_configs: Record<string, Record<string, unknown>>;
  // Builtin tool switches (tool_name -> enabled)
  builtin_tool_enabled: Record<string, boolean>;
  // Agent config
  max_iterations: number;
  auto_compact_input_tokens_threshold: number;
  compaction_micro_percent: number;
  compaction_auto_percent: number;
  compaction_full_percent: number;
  max_tool_result_tokens: number;
  summary_model?: string | null;
  project_instruction_budget_chars: number;
  enable_project_instructions: boolean;
  /** Personal prompt applied only to Piscis chat, heartbeat, pool coordination, and scheduled tasks. */
  piscis_personal_prompt: string;
  llm_read_timeout_secs: number;
  koi_timeout_secs: number;
  heartbeat_enabled: boolean;
  heartbeat_interval_mins: number;
  heartbeat_prompt: string;
  skill_evolution?: {
    review_enabled?: boolean;
    review_every_turn?: boolean;
    create_skill_min_tool_calls?: number;
    umbrella_skill_interval_turns?: number;
    curator_interval_hours?: number;
    curator_min_idle_hours?: number;
    stale_after_days?: number;
    archive_after_days?: number;
    curator_llm_merge_enabled?: boolean;
  };
  // Vision / multimodal
  vision_enabled: boolean;
  // Vision model (for UIA / screen_capture / desktop_automation)
  vision_use_main_llm: boolean;
  vision_provider: string;
  vision_model: string;
  vision_api_key: string;
  vision_base_url: string;
  /** When true, main-chat LLM responses stream as they arrive. Default false. */
  enable_streaming: boolean;
  // SSH Servers
  ssh_servers?: SshServerConfig[];
  // Named LLM Providers
  llm_providers?: LlmProviderConfig[];
  /** When true, multiple app instances may run simultaneously. Default false. */
  allow_multiple_instances?: boolean;
}

export interface SshServerConfig {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  /** Password — empty string means "unchanged" when saving */
  password: string;
  /** PEM private key — empty string means "unchanged" when saving */
  private_key: string;
}

/** A named LLM provider configuration. Multiple can be stored in Settings.llm_providers. */
export interface LlmProviderConfig {
  id: string;
  label: string;
  /** "anthropic" | "openai" | "deepseek" | "qwen" | "minimax" | "zhipu" | "kimi" | "custom" */
  provider: string;
  model: string;
  /** API key — empty string means "unchanged" when saving */
  api_key: string;
  /** Custom base URL (only used when provider = "custom") */
  base_url: string;
  /** Max output tokens; 0 = inherit from global settings */
  max_tokens: number;
}

export const settingsApi = {
  get: () => invoke<Settings>("get_settings"),
  save: (updates: Partial<Settings>) => invoke<Settings>("save_settings", { updates }),
  isConfigured: () => invoke<boolean>("is_configured"),
  getDefaultWorkspace: () => invoke<string>("get_default_workspace"),
};

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export interface Memory {
  id: string;
  content: string;
  category: string;
  confidence: number;
  source_session_id?: string | null;
  kind?: string;
  evidence_session_id?: string | null;
  last_seen_at?: string | null;
  created_at: string;
  updated_at: string;
}

export const memoryApi = {
  list: () => invoke<{ memories: Memory[]; total: number }>("list_memories"),
  add: (content: string, category?: string, confidence?: number) =>
    invoke<Memory>("add_memory", { content, category, confidence }),
  delete: (memoryId: string) => invoke<void>("delete_memory", { memoryId }),
  clear: () => invoke<void>("clear_memories"),
  /** Run the nightly Memory Consolidation (Dream) task immediately. */
  runConsolidationNow: () => invoke<string>("run_memory_consolidation_now", {}),
  /** Session-scoped lightweight consolidation after a long chat. */
  triggerConsolidationForSession: (sessionId: string) =>
    invoke<string>("trigger_memory_consolidation_for_session", { sessionId }),
};

// ---------------------------------------------------------------------------
// Skills (+ ClawHub registry bridge)
// ---------------------------------------------------------------------------

export interface Skill {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  icon: string;
  config: string;
}

export interface SkillCatalogItem {
  name: string;
  description: string;
  version: string;
  source: string;
  tools: string[];
  dependencies: string[];
  permissions: string[];
  platform: string[];
}

export interface SkillCompatibilityCheck {
  compatible: boolean;
  issues: string[];
  warnings: string[];
}

export interface SyncSkillsResult {
  synced: number;
  already_registered: number;
  errors: string[];
}

export const skillsApi = {
  list: () => invoke<{ skills: Skill[]; total: number }>("list_skills"),
  toggle: (skillId: string, enabled: boolean) =>
    invoke<void>("toggle_skill", { skillId, enabled }),
  catalog: () => invoke<SkillCatalogItem[]>("scan_skill_catalog"),
  install: (source: string) => invoke<SkillCatalogItem>("install_skill", { source }),
  uninstall: (skillName: string) => invoke<void>("uninstall_skill", { skillName }),
  checkCompat: (source: string) =>
    invoke<SkillCompatibilityCheck>("check_skill_compat", { source }),
  syncFromDisk: () => invoke<SyncSkillsResult>("sync_skills_from_disk"),
};

export interface ClawHubSkill {
  slug: string;
  name: string;
  description: string;
  version: string;
  author: string;
  downloads: number;
  stars: number;
  tags: string[];
  skill_url: string | null;
  zip_url: string | null;
  /** Platform requirements from SKILL.md (empty = all platforms) */
  platform: string[];
  /** Runtime dependencies from SKILL.md */
  dependencies: string[];
  /** null = not yet checked, true = compatible, false = incompatible */
  compatible: boolean | null;
  /** Populated when compatible === false */
  compat_issues: string[];
}

export interface ClawHubSearchResult {
  items: ClawHubSkill[];
  total: number;
  query: string;
}

export const clawHubApi = {
  search: (query: string, limit?: number) =>
    invoke<ClawHubSearchResult>("clawhub_search", { query, limit }),
  install: (slug: string, version?: string) =>
    invoke<SkillCatalogItem>("clawhub_install", { slug, version }),
};

// ---------------------------------------------------------------------------
// Anthropic claude-plugins-official (git-subdir skill bundles)
// ---------------------------------------------------------------------------

export interface ClaudePluginListItem {
  id: string;
  name: string;
  description: string;
  category: string;
  author: string;
  source_path: string;
  homepage: string | null;
  skill_count: number;
}

export interface ClaudePluginSkillPreview {
  dir_name: string;
  name: string;
  description: string;
  version: string;
}

export interface ClaudePluginListResult {
  items: ClaudePluginListItem[];
  total: number;
  query: string;
}

export interface ClaudePluginDetail {
  plugin: ClaudePluginListItem;
  skills: ClaudePluginSkillPreview[];
}

export interface ClaudePluginInstallResult {
  plugin_id: string;
  installed: SkillCatalogItem[];
  skipped: string[];
  errors: string[];
}

export const claudePluginsApi = {
  list: (query: string, limit?: number) =>
    invoke<ClaudePluginListResult>("claude_plugins_list", { query, limit }),
  detail: (pluginId: string) =>
    invoke<ClaudePluginDetail>("claude_plugins_detail", { pluginId }),
  install: (pluginId: string, skillDirs?: string[]) =>
    invoke<ClaudePluginInstallResult>("claude_plugins_install", {
      pluginId,
      skillDirs: skillDirs ?? null,
    }),
};

// ---------------------------------------------------------------------------
// Skill evolution (draft / promote / lock / curator)
// ---------------------------------------------------------------------------

export interface SkillRevision {
  id: string;
  skill_id: string;
  session_id: string | null;
  origin: string | null;
  diff_summary: string | null;
  content_before_hash: string | null;
  content_after_hash: string | null;
  created_at: string;
}

export interface SkillUsage {
  skill_id: string;
  view_count: number;
  use_count: number;
  patch_count: number;
  last_used_at: string | null;
  last_patched_at: string | null;
  state: string;
  pinned: number;
  created_by: string | null;
}

export interface CuratorStatus {
  last_run_at: string | null;
  agent_created_count: number;
  draft_count: number;
  learned_count: number;
  archived_count: number;
  top_used: SkillUsage[];
  least_used: SkillUsage[];
}

export interface SkillConfigMeta {
  lifecycle?: string;
  locked?: boolean;
  pinned?: boolean;
  source?: string;
}

export function parseSkillConfig(config: string): SkillConfigMeta {
  try {
    return JSON.parse(config) as SkillConfigMeta;
  } catch {
    return { lifecycle: "installed", locked: true, pinned: false };
  }
}

export const skillEvolutionApi = {
  promote: (skillId: string) => invoke<void>("promote_skill", { skillId }),
  discard: (skillId: string) => invoke<void>("discard_draft_skill", { skillId }),
  lock: (skillId: string) => invoke<void>("lock_skill", { skillId }),
  unlock: (skillId: string) => invoke<void>("unlock_skill", { skillId }),
  pin: (skillId: string) => invoke<void>("pin_skill", { skillId }),
  unpin: (skillId: string) => invoke<void>("unpin_skill", { skillId }),
  listRevisions: (params?: { skillId?: string; sessionId?: string; limit?: number }) =>
    invoke<{ revisions: SkillRevision[] }>("list_skill_revisions", {
      skillId: params?.skillId,
      sessionId: params?.sessionId,
      limit: params?.limit,
    }),
  listUsage: () => invoke<{ usage: SkillUsage[] }>("list_skill_usage"),
  curatorStatus: () => invoke<CuratorStatus>("curator_status"),
  curatorRun: (dryRun?: boolean) => invoke<string>("curator_run", { dryRun }),
  curatorRollback: () => invoke<void>("curator_rollback"),
  restoreArchived: (skillId: string) =>
    invoke<void>("restore_archived_skill", { skillId }),
};

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  session_id: string;
  timestamp: string;
  tool_name: string;
  action: string;
  input_summary?: string;
  result_summary?: string;
  is_error: boolean;
}

export const auditApi = {
  list: (params?: { session_id?: string; tool_name?: string; limit?: number; offset?: number }) =>
    invoke<AuditEntry[]>('get_audit_log', {
      sessionId: params?.session_id,
      toolName: params?.tool_name,
      limit: params?.limit ?? 50,
      offset: params?.offset ?? 0,
    }),
  clear: (sessionId?: string) => invoke<void>('clear_audit_log', { sessionId }),
};

// ---------------------------------------------------------------------------
// Session activity log (audits + plan snapshots + artifacts per session)
// ---------------------------------------------------------------------------

export interface PlanSnapshot {
  id: string;
  session_id: string;
  label: string;
  items_json: string;
  created_at: string;
}

export interface SessionActivityBundle {
  session_id: string;
  session_title: string;
  session_updated_at: string;
  audits: AuditEntry[];
  plan_snapshots: PlanSnapshot[];
  artifacts: SessionArtifact[];
  skill_revisions: SkillRevision[];
}

export const activityApi = {
  list: (limitSessions?: number) =>
    invoke<SessionActivityBundle[]>("get_session_activity_log", {
      limitSessions: limitSessions ?? 30,
    }),
};

// ---------------------------------------------------------------------------
// User tools (3rd-party tool plugins)
// ---------------------------------------------------------------------------

export interface ConfigFieldSchema {
  type: "string" | "number" | "boolean" | "password";
  label?: string;
  default?: unknown;
  description?: string;
  placeholder?: string;
}

export interface UserToolInfo {
  name: string;
  description: string;
  version: string;
  author: string;
  runtime: string;
  entrypoint: string;
  input_schema: unknown;
  config_schema: Record<string, ConfigFieldSchema>;
  has_config: boolean;
}

export const userToolsApi = {
  list: () => invoke<UserToolInfo[]>('list_user_tools'),
  install: (source: string) => invoke<UserToolInfo>('install_user_tool', { source }),
  uninstall: (toolName: string) => invoke<void>('uninstall_user_tool', { toolName }),
  saveConfig: (toolName: string, config: Record<string, unknown>) =>
    invoke<void>('save_user_tool_config', { toolName, config }),
  getConfig: (toolName: string) =>
    invoke<Record<string, unknown>>('get_user_tool_config', { toolName }),
};

// ---------------------------------------------------------------------------
// Built-in tools
// ---------------------------------------------------------------------------

export interface BuiltinToolInfo {
  name: string;
  description: string;
  icon: string;
  windows_only: boolean;
}

export const builtinToolsApi = {
  list: () => invoke<BuiltinToolInfo[]>('list_builtin_tools'),
  triggerHeartbeat: () => invoke<void>('trigger_heartbeat'),
};

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "sse";
  command: string;
  args: string[];
  url: string;
  env: Record<string, string>;
  enabled: boolean;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpTestResult {
  success: boolean;
  tools: McpToolInfo[];
  error?: string;
}

export const mcpApi = {
  list: () => invoke<McpServerConfig[]>("list_mcp_servers"),
  save: (servers: McpServerConfig[]) => invoke<void>("save_mcp_servers", { servers }),
  test: (config: McpServerConfig) => invoke<McpTestResult>("test_mcp_server", { config }),
};

// ---------------------------------------------------------------------------
// Enterprise capabilities
// ---------------------------------------------------------------------------

export interface EnterpriseCapabilityTemplate {
  platform: string;
  title: string;
  description: string;
  supported: boolean;
  mcp_server_name: string;
}

export interface EnterpriseCapabilityStatus {
  platform: string;
  supported: boolean;
  configured: boolean;
  enabled: boolean;
  mcp_configured: boolean;
  mcp_enabled: boolean;
  mcp_server_name: string;
  missing_credentials: string[];
  message: string;
}

export interface EnterpriseCapabilityTestResult {
  status: EnterpriseCapabilityStatus;
  success: boolean;
  tools: McpToolInfo[];
  error?: string;
  diagnostics: string[];
}

export const enterpriseCapabilityApi = {
  listTemplates: () =>
    invoke<EnterpriseCapabilityTemplate[]>("list_enterprise_capability_templates"),
  status: (platform: string) =>
    invoke<EnterpriseCapabilityStatus>("get_enterprise_capability_status", { platform }),
  enable: (platform: string) =>
    invoke<EnterpriseCapabilityStatus>("enable_enterprise_capability", { platform }),
  test: (platform: string) =>
    invoke<EnterpriseCapabilityTestResult>("test_enterprise_capability", { platform }),
};
