use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::BufRead;

pub const MAX_INPUT: usize = 6 * 1024 * 1024;
pub const MAX_LINE: usize = 1024 * 1024;
pub const MAX_TEXT: usize = 256 * 1024;

pub fn validate_request_id(id: &str) -> Result<(), String> {
    if !(1..=80).contains(&id.len())
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b':' | b'-'))
    {
        Err("Invalid Windows AI request ID".to_owned())
    } else {
        Ok(())
    }
}

pub fn read_bounded_line(reader: &mut impl BufRead) -> Result<Option<Vec<u8>>, String> {
    let mut line = Vec::new();
    loop {
        let buffer = reader
            .fill_buf()
            .map_err(|_| "Windows AI helper output is unavailable".to_owned())?;
        if buffer.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Err("Windows AI helper sent an incomplete message".to_owned())
            };
        }
        let count = buffer
            .iter()
            .position(|c| *c == b'\n')
            .map_or(buffer.len(), |i| i + 1);
        let complete = buffer[count - 1] == b'\n';
        if line.len() + count > MAX_LINE {
            return Err("Windows AI helper message exceeds its limit".to_owned());
        }
        line.extend_from_slice(&buffer[..count]);
        reader.consume(count);
        if complete {
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return Ok(Some(line));
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum Envelope {
    Result {
        id: String,
        data: Value,
    },
    Delta {
        id: String,
        text: String,
    },
    Progress {
        id: String,
        phase: String,
        progress: Option<f64>,
    },
    Error {
        id: String,
        code: String,
        message: String,
    },
}

pub fn parse_envelope(bytes: &[u8], expected_id: &str) -> Result<Envelope, String> {
    if bytes.len() > MAX_LINE {
        return Err("Windows AI helper message exceeds its limit".to_owned());
    }
    let envelope: Envelope = serde_json::from_slice(bytes)
        .map_err(|_| "Windows AI helper sent an invalid message".to_owned())?;
    let id = match &envelope {
        Envelope::Result { id, .. }
        | Envelope::Delta { id, .. }
        | Envelope::Progress { id, .. }
        | Envelope::Error { id, .. } => id,
    };
    if id != expected_id {
        return Err("Windows AI helper sent a message for an unknown request".to_owned());
    }
    match &envelope {
        Envelope::Delta { text, .. } if text.len() > 64 * 1024 => {
            Err("Windows AI delta exceeds its limit".to_owned())
        }
        Envelope::Progress {
            phase, progress, ..
        } if phase.len() > 160
            || progress.is_some_and(|p| !p.is_finite() || !(0.0..=1.0).contains(&p)) =>
        {
            Err("Windows AI helper sent invalid progress".to_owned())
        }
        Envelope::Error { code, message, .. }
            if code.is_empty() || code.len() > 80 || message.len() > 600 =>
        {
            Err("Windows AI helper sent an invalid failure".to_owned())
        }
        _ => Ok(envelope),
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Event {
    Delta {
        request_id: String,
        text: String,
    },
    Progress {
        request_id: String,
        phase: String,
        progress: Option<f64>,
    },
    Completed {
        request_id: String,
    },
    Cancelled {
        request_id: String,
    },
    Failed {
        request_id: String,
        code: String,
        message: String,
    },
}
