use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogueItem {
    pub id: String,
    pub title: String,
    pub description: String,
    pub settings_page: String,
    pub keywords: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Catalogue {
    pub version: u8,
    pub items: Vec<CatalogueItem>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentMatch {
    pub id: String,
    pub title: String,
    pub description: String,
    pub settings_page: String,
    pub source: &'static str,
}

impl Catalogue {
    pub fn embedded() -> Result<Self, String> {
        Self::parse(include_str!(
            "../../../src/services/windows-ai/catalogue.json"
        ))
    }

    pub fn parse(source: &str) -> Result<Self, String> {
        let catalogue: Self = serde_json::from_str(source)
            .map_err(|_| "Lumen public catalogue is invalid".to_owned())?;
        let pages = [
            "general",
            "appearance",
            "indexed-roots",
            "search",
            "local-ai",
            "agent-gateway",
            "computer-use",
            "activity",
            "privacy",
            "diagnostics",
        ];
        let mut ids = HashSet::new();
        if catalogue.version != 1
            || catalogue.items.len() > 1000
            || catalogue.items.iter().any(|item| {
                item.id.is_empty()
                    || item.id.len() > 80
                    || !ids.insert(&item.id)
                    || item.title.is_empty()
                    || item.title.len() > 160
                    || item.description.len() > 1000
                    || !pages.contains(&item.settings_page.as_str())
                    || item.keywords.len() > 32
                    || item.keywords.iter().any(|word| word.len() > 120)
            })
        {
            return Err("Lumen public catalogue is invalid".to_owned());
        }
        Ok(catalogue)
    }

    pub fn resolve(&self, ids: &[String]) -> Result<Vec<ContentMatch>, String> {
        if ids.len() > 20 {
            return Err("Windows public content returned too many results".to_owned());
        }
        let mut seen = HashSet::new();
        ids.iter()
            .filter(|id| seen.insert(id.as_str()))
            .map(|id| {
                self.items
                    .iter()
                    .find(|item| item.id == *id)
                    .map(|item| self.result(item, "semantic"))
                    .ok_or_else(|| {
                        "Windows public content returned an unknown catalogue ID".to_owned()
                    })
            })
            .collect()
    }

    pub fn lexical(&self, query: &str) -> Vec<ContentMatch> {
        let query = query.to_lowercase();
        let terms: Vec<_> = query.split_whitespace().collect();
        if terms.is_empty() {
            return Vec::new();
        }
        self.items
            .iter()
            .filter(|item| {
                let text = format!(
                    "{} {} {}",
                    item.title,
                    item.description,
                    item.keywords.join(" ")
                )
                .to_lowercase();
                terms.iter().all(|term| text.contains(term))
            })
            .take(20)
            .map(|item| self.result(item, "lexical"))
            .collect()
    }

    fn result(&self, item: &CatalogueItem, source: &'static str) -> ContentMatch {
        ContentMatch {
            id: item.id.clone(),
            title: item.title.clone(),
            description: item.description.clone(),
            settings_page: item.settings_page.clone(),
            source,
        }
    }
}
