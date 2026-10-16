use std::time::Duration;

use serde::de::DeserializeOwned;

const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

pub(crate) enum Error {
    Unavailable,
    Http(u16),
    TooLarge,
    InvalidData,
}

impl Error {
    pub(crate) fn message(self, service: &str) -> String {
        match self {
            Self::Unavailable => format!("{service} is unavailable."),
            Self::Http(status) => format!("{service} returned HTTP {status}."),
            Self::TooLarge => format!("{service} response exceeds Lumen's limits."),
            Self::InvalidData => format!("{service} returned invalid data."),
        }
    }
}

/// Owned local services never route through ambient proxies, redirects or retries.
pub(crate) fn client(deadline: Duration) -> Result<reqwest::Client, Error> {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(5))
        .timeout(deadline)
        .build()
        .map_err(|_| Error::Unavailable)
}

/// Check actual bytes as well as Content-Length; the client deadline includes body reads.
pub(crate) async fn body(mut response: reqwest::Response) -> Result<Vec<u8>, Error> {
    if !response.status().is_success() {
        return Err(Error::Http(response.status().as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(Error::TooLarge);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Error::Unavailable)? {
        if chunk.len() > MAX_RESPONSE_BYTES - bytes.len() {
            return Err(Error::TooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub(crate) async fn response(request: reqwest::RequestBuilder) -> Result<Vec<u8>, Error> {
    body(request.send().await.map_err(|_| Error::Unavailable)?).await
}

pub(crate) async fn json<T: DeserializeOwned>(
    request: reqwest::RequestBuilder,
) -> Result<T, Error> {
    serde_json::from_slice(&response(request).await?).map_err(|_| Error::InvalidData)
}
