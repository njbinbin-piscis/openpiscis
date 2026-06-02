//! Desktop-side pool plumbing.
//!
//! This module used to be called `koi` for historical reasons, but its
//! actual responsibility after Phase 4 is *pool coordination on the
//! desktop host* — specifically, bridging desktop Tauri command handlers
//! down to the kernel's [`piscis_kernel::pool::coordinator`]. See
//! [`bridge`] for that layer.
//!
//! For convenience, this module also re-exports the pool/Koi data
//! models that live in `piscis-core`, so commands / background tasks can
//! keep writing `crate::pool::KoiTodo`, `crate::pool::PoolSession`,
//! etc. without reaching across crates at every call site.
//!
//! The in-process `call_koi` tool (Piscis-side delegation) has been
//! relocated to [`crate::tools::call_koi`], which owns its own
//! `runtime` and `event_bus` submodules.

pub mod bridge;
pub mod notice;

pub use piscis_core::models::{
    KoiDefinition, KoiTodo, PoolMessage, PoolSession, StarterKoiSpec, KOI_COLORS, KOI_ICONS,
    STARTER_KOI_SPECS,
};
