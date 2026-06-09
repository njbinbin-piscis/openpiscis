// ─── Platform-specific / host-coupled tools (still live in the desktop crate)
pub mod app_control;
pub mod call_fish;
pub mod call_koi;
pub mod chat_ui;
pub mod chat_ui_listen;
pub mod chat_ui_patch;
pub mod chat_ui_schema;
pub mod im_channel;
pub mod im_send;
pub mod lsp;
#[cfg(target_os = "windows")]
pub mod office;
#[cfg(target_os = "windows")]
pub mod powershell;
pub mod read_lints;
pub mod skill_list;
pub mod skill_manage;
pub mod system_info;
#[cfg(target_os = "windows")]
pub mod wmi_tool;

// `plan_todo`, `pool_org`, `pool_chat` now live entirely in
// `piscis-kernel::tools::*` and register themselves through
// `register_neutral_tools` — the desktop no longer carries its own copy.

// ─── Platform-neutral tools re-exported from the kernel.
//
// Only modules that are still referenced by their full `crate::tools::<name>::…`
// path from outside this module need a re-export; everything else is
// reachable through `piscis_kernel::tools` directly and the `HostTools`
// trait handles all registration internally.
pub use piscis_kernel::tools::{mcp, user_tool};

// Desktop-automation + browser tools now live in the standalone RobotZ
// toolkit (`robotz-automation` / `robotz-browser`). They are re-exported here
// so the rest of the desktop crate keeps referring to them via
// `crate::tools::*`. The `piscis-kernel` feature on those crates makes the
// structs implement `piscis_kernel::Tool` directly, so registration is
// unchanged. The UIA mouse-precision calibration store moved with them
// (`robotz_automation::calibration`).
#[cfg(target_os = "windows")]
pub use robotz_automation::UiaTool;
pub use robotz_automation::{DesktopAutomationTool, ScreenTool};
pub use robotz_browser::BrowserTool;

#[cfg(target_os = "windows")]
pub mod com_invoke;
#[cfg(target_os = "windows")]
pub mod com_tool;

use std::collections::HashMap;

/// Runtime tool profile. The interactive desktop host never calls
/// [`apply_runtime_tool_profile`] / [`runtime_disabled_tools`] — it uses
/// the full builtin set — so we only enumerate the headless variants.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeToolProfile {
    HeadlessPiscis,
    HeadlessPool,
}

#[derive(Debug, Clone)]
pub struct ToolAvailability {
    pub name: &'static str,
    pub reason: Option<&'static str>,
}

const WINDOWS_ORIENTED_TOOLS: &[(&str, &str)] = &[
    (
        "powershell_query",
        "Disabled outside Windows: relies on Windows PowerShell semantics.",
    ),
    ("wmi", "Disabled outside Windows: WMI is Windows-only."),
    (
        "office",
        "Disabled outside Windows: current implementation depends on Windows Office automation.",
    ),
    (
        "uia",
        "Disabled outside Windows: UI Automation is Windows-only.",
    ),
    ("com", "Disabled outside Windows: COM/OLE is Windows-only."),
    (
        "com_invoke",
        "Disabled outside Windows: COM/OLE is Windows-only.",
    ),
];

// Tools disabled in headless piscis mode. `pool_org` / `pool_chat` /
// `plan_todo` are intentionally **not** in this list: they live in
// `piscis-kernel::tools` and are registered by every headless run so
// CLI/eval pool runs can still coordinate through the pool database.
// `call_koi` remains desktop-only because it needs the in-process Tauri
// runtime, which the CLI host does not host.
const HEADLESS_PISCIS_DISABLED_TOOLS: &[(&str, &str)] = &[
    (
        "call_koi",
        "Disabled in headless piscis mode: single-agent baseline should not delegate to Koi.",
    ),
    (
        "chat_ui",
        "Disabled in headless modes: no interactive desktop chat UI is available.",
    ),
    (
        "chat_ui_patch",
        "Disabled in headless modes: no interactive desktop chat UI is available.",
    ),
    (
        "chat_ui_listen",
        "Disabled in headless modes: no interactive desktop chat UI is available.",
    ),
];

const HEADLESS_COMMON_DISABLED_TOOLS: &[(&str, &str)] = &[
    (
        "chat_ui",
        "Disabled in headless modes: no interactive desktop chat UI is available.",
    ),
    (
        "chat_ui_patch",
        "Disabled in headless modes: no interactive desktop chat UI is available.",
    ),
    (
        "chat_ui_listen",
        "Disabled in headless modes: no interactive desktop chat UI is available.",
    ),
];

fn disable_tools(
    effective: &mut HashMap<String, bool>,
    disabled: &[(&'static str, &'static str)],
    output: &mut Vec<ToolAvailability>,
) {
    for (name, reason) in disabled {
        effective.insert((*name).to_string(), false);
        output.push(ToolAvailability {
            name,
            reason: Some(reason),
        });
    }
}

pub fn apply_runtime_tool_profile(
    base: &HashMap<String, bool>,
    profile: RuntimeToolProfile,
) -> HashMap<String, bool> {
    let mut effective = base.clone();
    let mut ignored = Vec::new();
    if !cfg!(target_os = "windows") {
        disable_tools(&mut effective, WINDOWS_ORIENTED_TOOLS, &mut ignored);
    }
    match profile {
        RuntimeToolProfile::HeadlessPiscis => {
            disable_tools(&mut effective, HEADLESS_COMMON_DISABLED_TOOLS, &mut ignored);
            disable_tools(&mut effective, HEADLESS_PISCIS_DISABLED_TOOLS, &mut ignored);
        }
        RuntimeToolProfile::HeadlessPool => {
            disable_tools(&mut effective, HEADLESS_COMMON_DISABLED_TOOLS, &mut ignored);
        }
    }
    effective
}

pub fn runtime_disabled_tools(profile: RuntimeToolProfile) -> Vec<ToolAvailability> {
    let mut out = Vec::new();
    let mut effective = HashMap::new();
    let mut seen = std::collections::HashSet::new();
    let mut push_unique = |disabled: &[(&'static str, &'static str)]| {
        let unique: Vec<_> = disabled
            .iter()
            .copied()
            .filter(|(name, _)| seen.insert(*name))
            .collect();
        disable_tools(&mut effective, &unique, &mut out);
    };
    if !cfg!(target_os = "windows") {
        push_unique(WINDOWS_ORIENTED_TOOLS);
    }
    match profile {
        RuntimeToolProfile::HeadlessPiscis => {
            push_unique(HEADLESS_COMMON_DISABLED_TOOLS);
            push_unique(HEADLESS_PISCIS_DISABLED_TOOLS);
        }
        RuntimeToolProfile::HeadlessPool => {
            push_unique(HEADLESS_COMMON_DISABLED_TOOLS);
        }
    }
    out
}
