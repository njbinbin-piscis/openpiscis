//! Cross-platform process spawning that never flashes a console window on Windows.
//!
//! Every `Command::new` invocation across the workspace must go through one of
//! the helpers in this module so the `CREATE_NO_WINDOW` flag is applied
//! uniformly on Windows. A `clippy.toml` `disallowed-methods` rule enforces
//! this at lint time — the only place `tokio::process::Command::new` and
//! `std::process::Command::new` are allowed is right here.
//!
//! Why this matters: missing the `CREATE_NO_WINDOW` flag causes a brief blue
//! console window to flash on screen for every short-lived child process
//! (ripgrep, npx, git, powershell, …). When a feature triggers many spawns
//! in sequence (file watcher → git status, search panel → ripgrep on every
//! keystroke, etc.) those flashes look like a popup storm to the user.
//!
//! The helpers are no-ops on non-Windows platforms.

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Build a [`tokio::process::Command`] that hides any child console window on
/// Windows. Use this everywhere instead of `tokio::process::Command::new`.
#[allow(clippy::disallowed_methods)]
pub fn tokio_command<S: AsRef<std::ffi::OsStr>>(program: S) -> tokio::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = tokio::process::Command::new(program);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }
    #[cfg(not(windows))]
    {
        tokio::process::Command::new(program)
    }
}

/// Build a [`std::process::Command`] that hides any child console window on
/// Windows. Use this everywhere instead of `std::process::Command::new`.
#[allow(clippy::disallowed_methods)]
pub fn std_command<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new(program);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new(program)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokio_command_returns_runnable_command() {
        // Just exercise the constructor — actually spawning would require a
        // platform-specific binary, which CI doesn't always have.
        let _ = tokio_command("echo");
    }

    #[test]
    fn std_command_returns_runnable_command() {
        let _ = std_command("echo");
    }
}
