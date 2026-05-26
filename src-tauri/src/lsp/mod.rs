//! LSP (Language Server Protocol) integration module.
//!
//! Provides:
//! - [`manager::LspManager`] — Global LSP process lifecycle manager.
//! - [`bridge::run_lsp_bridge`] — WebSocket bridge for Monaco Editor LSP client.

pub mod bridge;
pub mod manager;
