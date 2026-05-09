//! Native `im_send_message` tool — let the agent post a Markdown message
//! to an IM conversation using the existing [`crate::gateway::GatewayManager`].
//!
//! This is the "native" side of the layered enterprise-capability
//! architecture (see `pisci-core::scene::SceneKind::IMHeadless` doc):
//! credentials live on the platform application (bot_id/secret,
//! app_id/secret, app_key/secret), the channel uses them to maintain
//! a long-running WebSocket transport, and this tool re-uses the
//! *same* connection to push outbound messages without requiring a
//! second HTTP roundtrip or a separate token cache.
//!
//! Two (+1 auto) addressing modes:
//!   1. `binding_key` — preferred for replying to an inbound IM
//!      conversation. Looks up [`crate::store::db::ImSessionBinding`]
//!      and reuses its `latest_reply_target` + `routing_state_json`,
//!      so the channel can resolve `req_id` / `sessionWebhook` /
//!      DingTalk `msg_param_map`, etc.
//!   2. `channel` + `recipient` — for proactive messages the agent
//!      can address by raw recipient identifier (e.g. `userid` for
//!      WeCom or `open_id` for Feishu). The channel must already be
//!      registered with `GatewayManager`.
//!   3. auto-resolve — when no explicit addressing is provided, the
//!      tool resolves the IM binding from the current `session_id`
//!      via [`Database::find_im_session_binding_for_session`]. This
//!      works automatically in IM-driven sessions (WeChat, Feishu, etc.)
//!      without the agent needing to know its `binding_key`.
//!
//! If the requested IM channel is not connected (`channel_enabled =
//! false`), the tool returns a clean error rather than silently
//! falling back to HTTP, so the agent surfaces the actual gap to the
//! user.

use crate::app::markers::guess_mime_from_path;
use crate::gateway::{GatewayManager, MediaAttachment, OutboundMessage};
use crate::store::Database;
use async_trait::async_trait;
use pisci_kernel::agent::tool::{Tool, ToolContext, ToolResult};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{info, warn};
use uuid::Uuid;

pub struct ImSendMessageTool {
    pub gateway: Option<Arc<GatewayManager>>,
    pub db: Option<Arc<Mutex<Database>>>,
}

struct PreparedSend {
    outbound: OutboundMessage,
    history_session_id: Option<String>,
}

fn build_im_session_title(channel: &str, recipient: &str, is_group: bool) -> String {
    let label = if is_group {
        recipient.strip_prefix("group:").unwrap_or(recipient)
    } else {
        recipient
            .strip_prefix("dm:")
            .or_else(|| recipient.strip_prefix("user:"))
            .or_else(|| recipient.strip_prefix("chat:"))
            .unwrap_or(recipient)
    };
    format!("{} · {}", channel, label)
}

fn derive_outbound_binding_identity(
    channel: &str,
    recipient: &str,
    routing_state: Option<&Value>,
) -> (String, String, bool, String) {
    let normalized_channel = channel.to_ascii_lowercase();
    match normalized_channel.as_str() {
        "wechat" => {
            if let Some(session_id) = routing_state
                .and_then(|value| value.get("session_id"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                let group_key = format!("group:{}", session_id);
                return (group_key.clone(), group_key, true, session_id.to_string());
            }
            let peer_id = routing_state
                .and_then(|value| value.get("from_user_id"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(recipient)
                .to_string();
            (
                format!("dm:{}", peer_id),
                recipient.to_string(),
                false,
                peer_id,
            )
        }
        "wecom" => {
            let conversation_key =
                if recipient.starts_with("group:") || recipient.starts_with("user:") {
                    recipient.to_string()
                } else {
                    format!("user:{}", recipient)
                };
            let is_group = conversation_key.starts_with("group:");
            let peer_id = if is_group {
                conversation_key
                    .strip_prefix("group:")
                    .unwrap_or(recipient)
                    .to_string()
            } else {
                conversation_key
                    .strip_prefix("user:")
                    .unwrap_or(recipient)
                    .to_string()
            };
            (conversation_key, recipient.to_string(), is_group, peer_id)
        }
        _ => {
            let conversation_key = recipient.to_string();
            (
                conversation_key,
                recipient.to_string(),
                false,
                recipient.to_string(),
            )
        }
    }
}

async fn ensure_outbound_history_session(
    db: &Arc<Mutex<Database>>,
    outbound: &OutboundMessage,
) -> Option<String> {
    let (external_conversation_key, latest_reply_target, is_group, peer_id) =
        derive_outbound_binding_identity(
            &outbound.channel,
            &outbound.recipient,
            outbound.routing_state.as_ref(),
        );
    let binding_key = format!("{}::{}", outbound.channel, external_conversation_key);
    let routing_state_json = outbound
        .routing_state
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .ok()
        .flatten();
    let title = build_im_session_title(&outbound.channel, &peer_id, is_group);
    let source = format!("im_{}", outbound.channel);

    let db = db.lock().await;
    let session_id = match db.get_im_session_binding(&binding_key) {
        Ok(Some(binding)) => binding.session_id,
        Ok(None) => format!("im_{}_{}", outbound.channel, Uuid::new_v4()),
        Err(err) => {
            warn!(
                "im_send_message: failed to look up/create outbound binding for channel={} recipient={}: {}",
                outbound.channel, outbound.recipient, err
            );
            return None;
        }
    };

    if let Err(err) = db.ensure_im_session(&session_id, &title, &source) {
        warn!(
            "im_send_message: failed to ensure outbound IM session {} for channel={} recipient={}: {}",
            session_id, outbound.channel, outbound.recipient, err
        );
        return None;
    }
    let _ = db.rename_session(&session_id, &title);

    let group_name = if is_group {
        Some(peer_id.clone())
    } else {
        None
    };
    if let Err(err) = db.upsert_im_session_binding(&crate::store::db::ImSessionBindingUpsert {
        binding_key,
        channel: outbound.channel.clone(),
        external_conversation_key,
        session_id: session_id.clone(),
        peer_id,
        peer_name: None,
        is_group,
        group_name,
        latest_reply_target,
        routing_state_json,
    }) {
        warn!(
            "im_send_message: failed to upsert outbound binding for session {}: {}",
            session_id, err
        );
        return None;
    }

    Some(session_id)
}

fn render_sent_history_content(text: &str, media: Option<&MediaAttachment>) -> String {
    match media {
        Some(media) => {
            let filename = media.filename.as_deref().unwrap_or("attachment");
            format!(
                "{}\n[Sent attachment: {} ({})]",
                text, filename, media.media_type
            )
        }
        None => text.to_string(),
    }
}

#[async_trait]
impl Tool for ImSendMessageTool {
    fn name(&self) -> &str {
        "im_send_message"
    }

    fn description(&self) -> &str {
        "Send a Markdown text message, and optionally one local file attachment, to an IM conversation through the connected IM channel (WeCom / Feishu / DingTalk / WeChat / Slack / etc.). \
         \n\nADDRESSING (use one of):\
         \n- 'binding_key': preferred when replying to an existing IM conversation. The binding stores the channel name, the latest reply target, and any channel-specific routing state (e.g. WeCom 'req_id', DingTalk 'sessionWebhook'). Pass the 'binding_key' you received from an inbound IM message handler.\
         \n- 'channel' + 'recipient': for proactive (unprompted) messages. 'channel' is a registered channel name ('wecom', 'feishu', 'dingtalk', 'wechat', ...). 'recipient' is the channel-native target id (WeCom userid / Feishu open_id / DingTalk staffId / etc.). Optional 'routing_state' is forwarded verbatim if you know the channel-specific shape.\
         \n- auto-resolve: when none of the above are provided, the tool automatically resolves the IM binding from the current session. This works when you are in an IM-driven conversation (e.g. replying to a WeChat/Feishu user) — no explicit addressing parameters are needed.\
         \n\nThis tool returns an error when the requested channel is not currently connected. Channels are configured separately under Settings → IM; this tool only consumes the existing transport, it does NOT enable a channel.\
         \n\nOptional 'file_path' sends a local file attachment when the channel supports media upload. WeChat supports image/* and generic file attachments through iLink CDN upload. \
         \n\nKeep messages short and use Markdown for emphasis where the underlying channel supports it. Avoid sending walls of debug output."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["text"],
            "properties": {
                "text": {
                    "type": "string",
                    "description": "Message body (Markdown). Required."
                },
                "binding_key": {
                    "type": "string",
                    "description": "Stable conversation key from an inbound IM message (e.g. 'wecom::user:bot-123:user-456'). When provided, channel/recipient/routing_state are auto-filled from the persisted binding."
                },
                "channel": {
                    "type": "string",
                    "description": "Registered channel name when sending without a binding_key (e.g. 'wecom', 'feishu', 'dingtalk')."
                },
                "recipient": {
                    "type": "string",
                    "description": "Channel-native recipient id when sending without a binding_key."
                },
                "reply_to": {
                    "type": "string",
                    "description": "Optional message id to thread the reply against (channel-specific support)."
                },
                "routing_state": {
                    "description": "Optional channel-specific routing state object (forwarded as-is). Only useful when sending without a binding_key."
                },
                "file_path": {
                    "type": "string",
                    "description": "Optional absolute path to a local file to send as an attachment. Supported by channels with media upload support, including WeChat."
                },
                "media_type": {
                    "type": "string",
                    "description": "Optional MIME type override for file_path. If omitted, Pisci infers it from the file extension."
                }
            }
        })
    }

    fn is_read_only(&self) -> bool {
        false
    }

    async fn call(&self, input: Value, _ctx: &ToolContext) -> anyhow::Result<ToolResult> {
        let text = match input["text"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(t) => t.to_string(),
            None => {
                return Ok(ToolResult::err(
                    "'text' is required and must be a non-empty string",
                ))
            }
        };

        let gateway = match self.gateway.as_ref() {
            Some(g) => g.clone(),
            None => {
                return Ok(ToolResult::err(
                    "IM gateway is unavailable in this context (channels not initialised)",
                ))
            }
        };

        let binding_key = input["binding_key"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let channel_arg = input["channel"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let recipient_arg = input["recipient"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let media = match input["file_path"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(path) => match std::fs::read(path) {
                Ok(data) => {
                    let filename = std::path::Path::new(path)
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "file".to_string());
                    let media_type = input["media_type"]
                        .as_str()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                        .unwrap_or_else(|| guess_mime_from_path(path));
                    Some(MediaAttachment {
                        media_type,
                        url: None,
                        data: Some(data),
                        filename: Some(filename),
                    })
                }
                Err(err) => {
                    return Ok(ToolResult::err(format!(
                        "failed to read file_path '{}': {}",
                        path, err
                    )))
                }
            },
            None => None,
        };

        let prepared = if let Some(key) = binding_key {
            // Explicit binding_key provided — look it up directly.
            let db = match self.db.as_ref() {
                Some(d) => d.clone(),
                None => {
                    return Ok(ToolResult::err(
                        "database handle unavailable; cannot resolve binding_key",
                    ))
                }
            };
            let binding = {
                let db = db.lock().await;
                match db.get_im_session_binding(key) {
                    Ok(Some(b)) => b,
                    Ok(None) => {
                        return Ok(ToolResult::err(format!("IM binding '{}' not found", key)))
                    }
                    Err(err) => {
                        return Ok(ToolResult::err(format!(
                            "failed to look up binding '{}': {}",
                            key, err
                        )))
                    }
                }
            };
            let routing_state = binding
                .routing_state_json
                .as_deref()
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
            let recipient = if binding.latest_reply_target.trim().is_empty() {
                binding.peer_id.clone()
            } else {
                binding.latest_reply_target.clone()
            };
            PreparedSend {
                outbound: OutboundMessage {
                    channel: binding.channel.clone(),
                    recipient,
                    content: text,
                    reply_to: input["reply_to"].as_str().map(|s| s.to_string()),
                    media: media.clone(),
                    routing_state,
                },
                history_session_id: Some(binding.session_id.clone()),
            }
        } else if channel_arg.is_some() || recipient_arg.is_some() {
            // Explicit channel + recipient provided.
            let channel =
                match channel_arg {
                    Some(c) => c.to_string(),
                    None => return Ok(ToolResult::err(
                        "'channel' is required when 'recipient' is provided without 'binding_key'",
                    )),
                };
            let recipient =
                match recipient_arg {
                    Some(r) => r.to_string(),
                    None => return Ok(ToolResult::err(
                        "'recipient' is required when 'channel' is provided without 'binding_key'",
                    )),
                };
            let history_session_id = match self.db.as_ref() {
                Some(db) => {
                    let db = db.lock().await;
                    match db.find_im_session_binding_for_channel_recipient(&channel, &recipient) {
                        Ok(Some(binding)) => Some(binding.session_id),
                        Ok(None) => None,
                        Err(err) => {
                            warn!(
                                    "im_send_message: failed to resolve history session for channel={} recipient={}: {}",
                                    channel, recipient, err
                                );
                            None
                        }
                    }
                }
                None => None,
            };
            let routing_state = input.get("routing_state").cloned().filter(|v| !v.is_null());
            PreparedSend {
                outbound: OutboundMessage {
                    channel,
                    recipient,
                    content: text,
                    reply_to: input["reply_to"].as_str().map(|s| s.to_string()),
                    media,
                    routing_state,
                },
                history_session_id,
            }
        } else {
            // No explicit addressing — auto-resolve from current session.
            let db = match self.db.as_ref() {
                Some(d) => d.clone(),
                None => {
                    return Ok(ToolResult::err(
                        "either 'binding_key' or both 'channel' and 'recipient' are required \
                         (no database handle to auto-resolve from session)",
                    ))
                }
            };
            let binding = {
                let db = db.lock().await;
                match db.find_im_session_binding_for_session(&_ctx.session_id) {
                    Ok(Some(b)) => b,
                    Ok(None) => {
                        return Ok(ToolResult::err(format!(
                            "no IM binding found for current session '{}'; \
                             provide 'binding_key' or 'channel' + 'recipient'",
                            _ctx.session_id
                        )))
                    }
                    Err(err) => {
                        return Ok(ToolResult::err(format!(
                            "failed to look up binding for session '{}': {}",
                            _ctx.session_id, err
                        )))
                    }
                }
            };
            info!(
                "im_send_message: auto-resolved binding_key='{}' from session_id='{}'",
                binding.binding_key, _ctx.session_id
            );
            let routing_state = binding
                .routing_state_json
                .as_deref()
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
            let recipient = if binding.latest_reply_target.trim().is_empty() {
                binding.peer_id.clone()
            } else {
                binding.latest_reply_target.clone()
            };
            PreparedSend {
                outbound: OutboundMessage {
                    channel: binding.channel.clone(),
                    recipient,
                    content: text,
                    reply_to: input["reply_to"].as_str().map(|s| s.to_string()),
                    media,
                    routing_state,
                },
                history_session_id: Some(binding.session_id.clone()),
            }
        };

        let outbound = prepared.outbound;
        let history_session_id = prepared.history_session_id;

        match gateway.send(&outbound).await {
            Ok(()) => {
                let history_session_id = match (self.db.as_ref(), history_session_id) {
                    (Some(_), Some(session_id)) => Some(session_id),
                    (Some(db), None) => ensure_outbound_history_session(db, &outbound).await,
                    (None, None) => None,
                    (None, Some(session_id)) => Some(session_id),
                };
                if let (Some(db), Some(session_id)) =
                    (self.db.as_ref(), history_session_id.as_deref())
                {
                    let history_content =
                        render_sent_history_content(&outbound.content, outbound.media.as_ref());
                    let db = db.lock().await;
                    let title =
                        build_im_session_title(&outbound.channel, &outbound.recipient, false);
                    let source = format!("im_{}", outbound.channel);
                    if let Err(err) = db.ensure_im_session(session_id, &title, &source) {
                        warn!(
                            "im_send_message: sent successfully but failed to ensure history session {}: {}",
                            session_id, err
                        );
                    }
                    if let Err(err) = db.append_message(session_id, "assistant", &history_content) {
                        warn!(
                            "im_send_message: sent successfully but failed to persist history for session {}: {}",
                            session_id, err
                        );
                    }
                }
                info!(
                    "im_send_message: channel={} recipient={} chars={}",
                    outbound.channel,
                    outbound.recipient,
                    outbound.content.chars().count()
                );
                Ok(ToolResult::ok(format!(
                    "Sent message via channel '{}' to '{}'.",
                    outbound.channel, outbound.recipient
                )))
            }
            Err(err) => {
                warn!(
                    "im_send_message: gateway.send failed channel={} recipient={}: {}",
                    outbound.channel, outbound.recipient, err
                );
                Ok(ToolResult::err(format!(
                    "Gateway send failed (channel='{}'): {}",
                    outbound.channel, err
                )))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_sent_history_content_keeps_text_without_attachment() {
        assert_eq!(render_sent_history_content("done", None), "done");
    }

    #[test]
    fn render_sent_history_content_includes_attachment_marker() {
        let media = MediaAttachment {
            media_type: "image/png".to_string(),
            url: None,
            data: None,
            filename: Some("chart.png".to_string()),
        };
        assert_eq!(
            render_sent_history_content("done", Some(&media)),
            "done\n[Sent attachment: chart.png (image/png)]"
        );
    }

    #[test]
    fn derive_outbound_binding_identity_matches_wechat_dm_shape() {
        let (conversation_key, latest_reply_target, is_group, peer_id) =
            derive_outbound_binding_identity("wechat", "wx-user-1", None);
        assert_eq!(conversation_key, "dm:wx-user-1");
        assert_eq!(latest_reply_target, "wx-user-1");
        assert!(!is_group);
        assert_eq!(peer_id, "wx-user-1");
    }

    #[test]
    fn derive_outbound_binding_identity_matches_wecom_user_shape() {
        let (conversation_key, latest_reply_target, is_group, peer_id) =
            derive_outbound_binding_identity("wecom", "zhangsan", None);
        assert_eq!(conversation_key, "user:zhangsan");
        assert_eq!(latest_reply_target, "zhangsan");
        assert!(!is_group);
        assert_eq!(peer_id, "zhangsan");
    }
}
