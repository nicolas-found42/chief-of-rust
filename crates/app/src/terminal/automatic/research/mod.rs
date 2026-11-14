//! Automatic Terminal research: source collection, identity anchoring,
//! evidence verification/repair, section generation, and run execution.

mod collect;
mod evidence;
mod execute;
mod identity;
mod schema;
mod sections;

#[cfg(test)]
mod tests;

pub(super) use collect::{bound_sources, model_sources, usable_source, web_sources};
pub(super) use evidence::{check_support, cited_assertions};
pub(super) use execute::execute;
pub(super) use identity::{check_citations, screen};
