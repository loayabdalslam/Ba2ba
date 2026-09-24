use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("protocol error: {0}")]
    Protocol(String),
    #[error("unauthorized: {0}")]
    Unauthorized(String),
    #[error("{code}: {message}")]
    Remote { code: String, message: String },
    #[error("timed out: {0}")]
    Timeout(String),
    #[error("cancelled")]
    Cancelled,
    #[error("connection error: {0}")]
    Connection(String),
    #[error("http error: {0}")]
    Http(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Other(String),
}

impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        Error::Http(e.to_string())
    }
}

impl From<tokio_tungstenite::tungstenite::Error> for Error {
    fn from(e: tokio_tungstenite::tungstenite::Error) -> Self {
        Error::Connection(e.to_string())
    }
}

impl serde::Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
