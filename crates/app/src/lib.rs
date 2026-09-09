//! Stub crate for the Rust rewrite (issue #8). The framework choice comes
//! later; this banner is the seam the Docker boot check greps for.

/// One-line banner the stub binary prints on boot.
pub fn banner() -> String {
    format!("chief-of-rust {}", env!("CARGO_PKG_VERSION"))
}

#[cfg(test)]
mod tests {
    use super::banner;

    #[test]
    fn banner_names_the_app_and_version() {
        assert_eq!(banner(), "chief-of-rust 0.1.0");
    }
}
