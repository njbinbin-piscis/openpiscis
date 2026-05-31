use async_trait::async_trait;
use pisci_kernel::agent::messages::AgentEvent;
use pisci_kernel::agent::tool::{Tool, ToolContext, ToolResult};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

pub struct ChatUiTool {
    pub app: AppHandle,
}

fn render_interactive_response_result(values: &Value) -> String {
    let json = serde_json::to_string_pretty(values).unwrap_or_else(|_| format!("{:?}", values));
    format!(
        "USER_INTERACTIVE_RESPONSE_JSON:\n{}\n\n\
This is the user's latest explicit structured input from the interactive card. \
You MUST treat these values as authoritative. Override any prior defaults, assumptions, examples, or tentative plans that conflict with this response. \
If a field is present here, use this submitted value exactly unless the user later changes it.",
        json
    )
}

#[async_trait]
impl Tool for ChatUiTool {
    fn name(&self) -> &str {
        "chat_ui"
    }

    fn description(&self) -> &str {
        "Display an interactive UI card (Chat UI Protocol v1) for structured user input. \
         Supports text/number/date/time/slider/switch, select/radio/checkbox/tags with optional custom values, \
         koi_picker, project_picker, conditional show_when, validation (required, min/max, pattern), and action buttons. \
         Full spec: docs/chat-ui-protocol.md in the repo. \
         Use for multi-field or constrained choices; NOT for simple yes/no (ask in text). \
         Blocks until submit; returns USER_INTERACTIVE_RESPONSE_JSON — treat field ids and values as authoritative."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["ui_definition"],
            "properties": {
                "ui_definition": {
                    "type": "object",
                    "description": "The interactive UI card definition.",
                    "required": ["blocks"],
                    "properties": {
                        "protocol_version": {
                            "type": "string",
                            "enum": ["1"],
                            "description": "Protocol version; set to \"1\"."
                        },
                        "title": {
                            "type": "string",
                            "description": "Card title displayed at the top."
                        },
                        "description": {
                            "type": "string",
                            "description": "Optional description text below the title."
                        },
                        "submit_label": {
                            "type": "string",
                            "description": "Label for the auto-generated Submit button when no actions block is present."
                        },
                        "blocks": {
                            "type": "array",
                            "description": "Array of UI blocks to render.",
                            "items": {
                                "type": "object",
                                "required": ["type"],
                                "properties": {
                                    "type": {
                                        "type": "string",
                                        "enum": [
                                            "text", "section", "divider",
                                            "text_input", "number_input", "slider", "switch",
                                            "date", "time", "datetime",
                                            "select", "radio", "checkbox", "tags",
                                            "koi_picker", "project_picker",
                                            "confirm", "actions"
                                        ],
                                        "description": "Block type (see docs/chat-ui-protocol.md)."
                                    },
                                    "id": {
                                        "type": "string",
                                        "description": "Unique snake_case field id for value-bearing blocks."
                                    },
                                    "label": {
                                        "type": "string",
                                        "description": "Visible label."
                                    },
                                    "description": {
                                        "type": "string",
                                        "description": "Help text shown under the label."
                                    },
                                    "required": {
                                        "type": "boolean",
                                        "description": "If true, field must be filled before submit."
                                    },
                                    "disabled": {
                                        "type": "boolean",
                                        "description": "If true, control is read-only."
                                    },
                                    "value": {
                                        "description": "Value submitted when this block is used as a single-button action fallback."
                                    },
                                    "content": {
                                        "type": "string",
                                        "description": "Text content for 'text' blocks (supports markdown)."
                                    },
                                    "options": {
                                        "type": "array",
                                        "description": "Options for radio/checkbox/select blocks.",
                                        "items": {
                                            "type": "object",
                                            "properties": {
                                                "value": { "type": "string" },
                                                "label": { "type": "string" },
                                                "description": { "type": "string" }
                                            }
                                        }
                                    },
                                    "default": {
                                        "description": "Default value (string for radio/select, array for checkbox)."
                                    },
                                    "placeholder": {
                                        "type": "string",
                                        "description": "Placeholder for text/tags/select."
                                    },
                                    "allow_custom": {
                                        "type": "boolean",
                                        "description": "For select/radio/checkbox: allow Other with free-text (submitted as user string, not __custom__)."
                                    },
                                    "custom_label": {
                                        "type": "string",
                                        "description": "Label for the custom/Other option."
                                    },
                                    "multiline": {
                                        "type": "boolean",
                                        "description": "For text_input: render as textarea."
                                    },
                                    "rows": {
                                        "type": "integer",
                                        "description": "Textarea row count when multiline is true."
                                    },
                                    "input_mode": {
                                        "type": "string",
                                        "enum": ["text", "email", "url", "password"],
                                        "description": "For text_input: input subtype."
                                    },
                                    "min_length": {
                                        "type": "integer",
                                        "description": "Minimum string length for text_input."
                                    },
                                    "max_length": {
                                        "type": "integer",
                                        "description": "Maximum string length for text_input."
                                    },
                                    "pattern": {
                                        "type": "string",
                                        "description": "Regex pattern for text_input validation."
                                    },
                                    "show_when": {
                                        "type": "object",
                                        "description": "Conditional visibility.",
                                        "properties": {
                                            "field": { "type": "string" },
                                            "equals": {},
                                            "one_of": { "type": "array" },
                                            "not_equals": {}
                                        }
                                    },
                                    "suggestions": {
                                        "type": "array",
                                        "description": "Suggested koi IDs for koi_picker.",
                                        "items": { "type": "string" }
                                    },
                                    "allow_new": {
                                        "type": "boolean",
                                        "description": "For project_picker: allow creating a new project."
                                    },
                                    "min": {
                                        "description": "number/slider: min value; checkbox/tags/koi_picker: min selection count; date/time: min ISO bound string."
                                    },
                                    "max": {
                                        "description": "number/slider: max value; checkbox/tags/koi_picker: max selection count; date/time: max ISO bound string."
                                    },
                                    "step": {
                                        "type": "number",
                                        "description": "Step for number_input/slider."
                                    },
                                    "buttons": {
                                        "type": "array",
                                        "description": "Button definitions for 'actions' or 'confirm' blocks. The UI renders exactly these buttons. Each button's label is display text and value is the submitted semantic value.",
                                        "items": {
                                            "type": "object",
                                            "required": ["label"],
                                            "properties": {
                                                "id": { "type": "string" },
                                                "label": { "type": "string" },
                                                "value": {
                                                    "description": "Semantic value submitted when the user clicks this button. If omitted, the frontend falls back to id, then label."
                                                },
                                                "style": {
                                                    "type": "string",
                                                    "enum": ["primary", "danger", "default"]
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        })
    }

    fn is_read_only(&self) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> anyhow::Result<ToolResult> {
        let ui_def = input.get("ui_definition").cloned().unwrap_or(Value::Null);

        if ui_def.is_null() || ui_def.get("blocks").is_none() {
            return Ok(ToolResult::err(
                "ui_definition must contain a 'blocks' array.",
            ));
        }

        // Use the persisted tool_use id so the frontend can submit against the same
        // key after messages reload from the DB (historical cards use call.id).
        let request_id = ctx
            .tool_use_id
            .clone()
            .filter(|id| !id.trim().is_empty())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let (resp_tx, resp_rx) = tokio::sync::oneshot::channel();

        // Register the response channel
        {
            let state = self.app.state::<crate::store::AppState>();
            let mut map = state.interactive_responses.lock().await;
            map.insert(request_id.clone(), resp_tx);
        }

        // Emit the interactive UI event to the frontend
        let event = AgentEvent::InteractiveUi {
            request_id: request_id.clone(),
            ui_definition: ui_def.clone(),
        };
        let event_key = format!("agent_event_{}", ctx.session_id);
        let payload = serde_json::to_value(&event).unwrap_or_default();
        let _ = self.app.emit(&event_key, payload);

        // Wait for user response with 5-minute timeout
        match tokio::time::timeout(std::time::Duration::from_secs(300), resp_rx).await {
            Ok(Ok(values)) => Ok(ToolResult::ok(render_interactive_response_result(&values))),
            Ok(Err(_)) => Ok(ToolResult::err(
                "Interactive UI response channel was dropped (user may have navigated away).",
            )),
            Err(_) => {
                // Clean up on timeout
                let state = self.app.state::<crate::store::AppState>();
                let mut map = state.interactive_responses.lock().await;
                map.remove(&request_id);
                Ok(ToolResult::err(
                    "Interactive UI timed out after 5 minutes with no user response.",
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn interactive_response_result_is_authoritative_and_machine_readable() {
        let result = render_interactive_response_result(&json!({
            "game_type": "puzzle",
            "project_name": "timy"
        }));

        assert!(result.contains("USER_INTERACTIVE_RESPONSE_JSON"));
        assert!(result.contains("\"game_type\": \"puzzle\""));
        assert!(result.contains("\"project_name\": \"timy\""));
        assert!(result.contains("authoritative"));
        assert!(result.contains("Override any prior defaults"));
    }
}
