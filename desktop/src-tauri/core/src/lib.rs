//! Core logic of the Bee2Bee desktop app, independent of the GUI so it can be tested headless.

pub mod deploy;
pub mod error;
pub mod identity;
pub mod mesh;
pub mod ollama;
pub mod protocol;

pub use error::{Error, Result};
