use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activation {
    pub activation_id: String,
    pub agent_name: &'static str,
    pub prompt: String,
}

pub fn validate_prompt(prompt: &str) -> Result<(), String> {
    if prompt.trim().is_empty()
        || prompt.encode_utf16().count() > 4000
        || prompt.chars().any(|c| c == '\0')
    {
        Err("Agent tasks must contain 1 to 4,000 characters".to_owned())
    } else {
        Ok(())
    }
}

fn decode(value: &str) -> Result<String, String> {
    let mut bytes = Vec::with_capacity(value.len());
    let mut characters = value.as_bytes().iter().copied();
    while let Some(character) = characters.next() {
        match character {
            b'+' => bytes.push(b' '),
            b'%' => {
                let high = characters.next().and_then(|c| (c as char).to_digit(16));
                let low = characters.next().and_then(|c| (c as char).to_digit(16));
                let (Some(high), Some(low)) = (high, low) else {
                    return Err("Invalid agent activation encoding".to_owned());
                };
                bytes.push((high * 16 + low) as u8);
            }
            byte => bytes.push(byte),
        }
    }
    String::from_utf8(bytes).map_err(|_| "Invalid agent activation encoding".to_owned())
}

pub fn parse_activation(uri: &str) -> Result<Activation, String> {
    if uri.len() > 64 * 1024 {
        return Err("Agent activation is too large".to_owned());
    }
    let uri = reqwest::Url::parse(uri).map_err(|_| "Invalid agent activation URI".to_owned())?;
    if uri.scheme() != "lumen"
        || uri.host().is_some()
        || uri.path() != "agent"
        || uri.fragment().is_some()
    {
        return Err("Unsupported agent activation URI".to_owned());
    }
    let mut agent_name = None;
    let mut prompt = None;
    for pair in uri.query().unwrap_or_default().split('&') {
        let (key, value) = pair
            .split_once('=')
            .ok_or_else(|| "Invalid agent activation parameters".to_owned())?;
        let key = decode(key)?;
        let value = decode(value)?;
        match key.as_str() {
            "agentName" if agent_name.is_none() => agent_name = Some(value),
            "prompt" if prompt.is_none() => prompt = Some(value),
            _ => return Err("Unsupported agent activation parameters".to_owned()),
        }
    }
    if agent_name.as_deref() != Some("lumen.browser") {
        return Err("Unknown Lumen agent".to_owned());
    }
    let prompt = prompt
        .ok_or_else(|| "Agent activation has no task".to_owned())?
        .trim()
        .to_owned();
    validate_prompt(&prompt)?;
    Ok(Activation {
        activation_id: uuid::Uuid::new_v4().to_string(),
        agent_name: "lumen.browser",
        prompt,
    })
}

#[derive(Default)]
pub struct ActivationQueue {
    pending: VecDeque<Activation>,
    fingerprints: VecDeque<(Vec<u8>, Instant)>,
}

impl ActivationQueue {
    pub fn enqueue(&mut self, uri: &str) -> Result<Option<Activation>, String> {
        let activation = parse_activation(uri)?;
        let fingerprint = Sha256::digest(activation.prompt.as_bytes()).to_vec();
        self.fingerprints
            .retain(|(_, delivered)| delivered.elapsed() < Duration::from_secs(2));
        if self
            .pending
            .iter()
            .any(|pending| pending.prompt == activation.prompt)
            || self
                .fingerprints
                .iter()
                .any(|(previous, _)| *previous == fingerprint)
        {
            return Ok(None);
        }
        if self.pending.len() >= 8 {
            return Err("Too many pending Windows agent drafts".to_owned());
        }
        self.fingerprints.push_back((fingerprint, Instant::now()));
        if self.fingerprints.len() > 16 {
            self.fingerprints.pop_front();
        }
        self.pending.push_back(activation.clone());
        Ok(Some(activation))
    }

    pub fn consume(&mut self) -> Option<Activation> {
        self.pending.pop_front()
    }
}
