//! A company Dossier's own sections assert company-level facts (issue #74).
//!
//! The generation prompts already ask for a company-level assessment and a
//! legal record, but a model can still answer `Executive assessment` with an
//! executive's biography and `Entity, ownership and history` with a publisher
//! notice. This pass repairs those two sections from retained evidence without
//! consulting a model: it moves a company-level proposition to the front, adds
//! the registry facts the section omits, and states an unestablished ownership
//! history as an explicit gap with a recorded limitation. It never infers
//! ownership, and a person's Dossier passes through unchanged.

use super::{Identity, Reference, research::model_sources};
use crate::research::{ENTITY_HEADING as ENTITY, EXECUTIVE_HEADING as EXECUTIVE, SourceRecord};
use serde_json::Value;

/// Shorter names match unrelated words in prose, so they never identify a
/// person-subject block.
const MIN_NAME_CHARS: usize = 3;
/// Shorter subject keys only match exactly; substring matching would pull in
/// unrelated companies.
const MIN_SUBSTRING_SUBJECT_CHARS: usize = 4;

/// App-authored gap for a company whose retained evidence carries no ownership
/// record. Its literal presence makes the pass idempotent across retries.
const OWNERSHIP_GAP: &str =
    "The retained evidence does not establish ownership or founding history";

const OWNERSHIP_MARKERS: [&str; 12] = [
    "owned by",
    "owner of",
    "wholly owned",
    "wholly-owned",
    "subsidiary of",
    "parent company",
    "shareholder",
    "acquired by",
    "controlled by",
    "controlling stake",
    "majority stake",
    "equity interest",
];

const FOUNDING_MARKERS: [&str; 5] = [
    "founded",
    "founder",
    "incorporated in",
    "established in",
    "established by",
];

/// One registry-derived proposition the app may add to the legal record.
struct Fact {
    statement: String,
    source_id: String,
    /// Normalized values that prove the published section already carries the
    /// fact. Any one match suppresses the addition.
    anchors: Vec<String>,
}

#[derive(Default)]
struct CompanyFacts {
    legal_name: Option<Fact>,
    registration: Option<Fact>,
    address: Option<Fact>,
    /// A validated identity quotation that states registry detail in prose,
    /// where no structured registry field is available. Appending the literal
    /// quotation never turns its subject into a different entity.
    registry_record: Option<Fact>,
    founding: Option<Fact>,
    ownership: Option<Fact>,
}

/// Return the company body with both subject sections repaired. A person
/// Dossier, and a company Dossier whose sections are already company-level,
/// is returned byte-for-byte unchanged.
pub(super) fn enforce(
    body: &str,
    identity: &Identity,
    person_names: &[String],
    identity_references: &[Reference],
    sources: &[SourceRecord],
    limits: &mut Vec<String>,
) -> String {
    if identity.kind != "company" {
        return body.to_owned();
    }
    let facts = company_facts(&identity.name, identity_references, sources);
    let body = update_section(body, EXECUTIVE, |content| {
        enforce_executive(content, identity, person_names, &facts, limits)
    });
    update_section(&body, ENTITY, |content| {
        enforce_entity(content, identity, person_names, &facts, limits)
    })
}

fn enforce_executive(
    content: &str,
    identity: &Identity,
    person_names: &[String],
    facts: &CompanyFacts,
    limits: &mut Vec<String>,
) -> String {
    let mut blocks = blocks(content);
    let biography = |block: &String| {
        mentions_person(block, person_names) && !mentions_company(block, identity, facts)
    };
    // A proposition about no named person is a company-level proposition in a
    // company Dossier. Drop a purely personal biography wherever it appears;
    // a company fact that names its founder or executive is kept.
    if !blocks.is_empty() && !blocks.iter().any(biography) {
        return content.to_owned();
    }
    blocks.retain(|block| !biography(block));
    if blocks.is_empty() {
        // No company-level proposition was drafted at all. Lead with a retained
        // company fact when the evidence carries one; otherwise the section
        // opens with the explicit evidence gap the evidence warrants.
        blocks.push(match facts
            .legal_name
            .as_ref()
            .or(facts.registration.as_ref())
            .or(facts.address.as_ref())
        {
            Some(fact) => cited(fact),
            None => {
                let name = identity.name.trim();
                record(
                    limits,
                    format!(
                        "The \"{EXECUTIVE}\" section opens with an explicit evidence gap because retained evidence does not establish a company-level assessment for {name}."
                    ),
                );
                format!(
                    "- The retained evidence does not establish a company-level assessment for {name}; the observations below concern named individuals."
                )
            }
        });
    }
    render(&blocks)
}

fn enforce_entity(
    content: &str,
    identity: &Identity,
    person_names: &[String],
    facts: &CompanyFacts,
    limits: &mut Vec<String>,
) -> String {
    let mut blocks = blocks(content);
    // A legal record is never a person's biography: drop a purely personal
    // block wherever it appears, while keeping a company fact that names its
    // founder or executive.
    let biography = |block: &String| {
        mentions_person(block, person_names) && !mentions_company(block, identity, facts)
    };
    blocks.retain(|block| !biography(block));
    let mut section = blocks.join("\n");
    for fact in facts
        .legal_name
        .iter()
        .chain(facts.registration.iter())
        .chain(facts.address.iter())
        .chain(facts.registry_record.iter())
    {
        if !carries(&section, &fact.anchors) {
            blocks.push(cited(fact));
            section = blocks.join("\n");
        }
    }
    if let Some(fact) = &facts.founding
        && !carries_marker(&section, &FOUNDING_MARKERS)
    {
        blocks.push(cited(fact));
        section = blocks.join("\n");
    }
    if let Some(fact) = &facts.ownership
        && !carries_marker(&section, &OWNERSHIP_MARKERS)
        && !carries(&section, &fact.anchors)
    {
        blocks.push(cited(fact));
        section = blocks.join("\n");
    }
    // Ownership absent from the retained evidence is a recorded gap, not an
    // invitation to infer a parent, owner or acquisition. A drafted section
    // that already states sourced ownership is not contradicted.
    if facts.ownership.is_none() && !carries_marker(&section, &OWNERSHIP_MARKERS) {
        if !section.contains(OWNERSHIP_GAP) && !states_missing_ownership(&section) {
            let name = identity.name.trim();
            blocks.push(format!(
                "- {OWNERSHIP_GAP} for {name}; no ownership is inferred and this remains an explicit evidence gap."
            ));
        }
        record(
            limits,
            format!(
                "The \"{ENTITY}\" section does not establish ownership because retained evidence carries no ownership record; no ownership history was inferred."
            ),
        );
    }
    render(&blocks)
}

fn blocks(content: &str) -> Vec<String> {
    let mut blocks: Vec<String> = Vec::new();
    for line in content.lines() {
        let line = line.trim_end();
        if line.trim().is_empty() {
            continue;
        }
        let bullet = line.trim_start().starts_with("- ") || line.trim_start().starts_with("* ");
        match blocks.last_mut() {
            // Keep a wrapped paragraph together so reordering never splits it.
            Some(last)
                if !bullet
                    && !last.trim_start().starts_with("- ")
                    && !last.trim_start().starts_with("* ") =>
            {
                last.push('\n');
                last.push_str(line);
            }
            _ => blocks.push(line.to_owned()),
        }
    }
    blocks
}

fn render(blocks: &[String]) -> String {
    format!("\n\n{}", blocks.join("\n"))
}

fn update_section(body: &str, title: &str, mut update: impl FnMut(&str) -> String) -> String {
    let mut chunks = body.split("\n## ").map(str::to_owned).collect::<Vec<_>>();
    let last = chunks.len().saturating_sub(1);
    for (index, chunk) in chunks.iter_mut().enumerate() {
        let heading = chunk.lines().next().unwrap_or_default();
        if heading.trim_start_matches("## ").trim() != title {
            continue;
        }
        let content = chunk
            .strip_prefix(heading)
            .unwrap_or_default()
            .trim_start_matches('\n');
        // The split leaves the newline that preceded the next heading inside
        // this chunk. Preserve it so the repaired body hashes exactly like the
        // processed body a retry loads and discovery checkpoints stay valid.
        let separator = if index < last { "\n" } else { "" };
        *chunk = format!(
            "{heading}\n\n{}{separator}",
            update(content).trim_matches('\n')
        );
    }
    chunks.join("\n## ")
}

fn cited(fact: &Fact) -> String {
    format!("- {} [{}]", fact.statement, fact.source_id)
}

fn statement(text: String) -> String {
    format!("{}.", text.trim().trim_end_matches('.'))
}

fn carries(section: &str, anchors: &[String]) -> bool {
    let section = prose_key(section);
    anchors.iter().any(|anchor| section.contains(anchor))
}

fn carries_marker(text: &str, markers: &[&str]) -> bool {
    let text = text.to_lowercase();
    markers.iter().any(|marker| text.contains(marker))
}

/// A draft may already disclose that ownership is unknown. That is the same
/// gap; the pass must not append a second sentence, but the limitation still
/// belongs in the Run's record.
fn states_missing_ownership(text: &str) -> bool {
    let text = text.to_lowercase();
    text.contains("ownership")
        && [
            "unknown",
            "not established",
            "not disclosed",
            "no ownership",
            "unresolved",
            "not known",
        ]
        .iter()
        .any(|marker| text.contains(marker))
}

fn mentions_person(block: &str, person_names: &[String]) -> bool {
    let block = prose_key(block);
    person_names
        .iter()
        .map(|name| prose_key(name))
        .any(|name| name.len() >= MIN_NAME_CHARS && block.contains(&name))
}

fn mentions_company(block: &str, identity: &Identity, facts: &CompanyFacts) -> bool {
    let block = prose_key(block);
    let mut anchors = vec![prose_key(&identity.name)];
    if let Some(fact) = &facts.legal_name {
        anchors.extend(fact.anchors.iter().cloned());
    }
    anchors
        .into_iter()
        .any(|anchor| anchor.len() >= MIN_NAME_CHARS && block.contains(&anchor))
}

fn record(limits: &mut Vec<String>, limitation: String) {
    if !limits.iter().any(|existing| existing == &limitation) {
        limits.push(limitation);
    }
}

/// Case- and punctuation-free prose, so a registry name ("ACME, INC.") and
/// its draft mention ("Acme Inc") compare equal.
fn prose_key(value: &str) -> String {
    value
        .chars()
        .filter(|value| value.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn matches_subject(name: &str, subject: &str) -> bool {
    let name = prose_key(name);
    !name.is_empty()
        && (name == subject
            || (subject.len() >= MIN_SUBSTRING_SUBJECT_CHARS && name.contains(subject)))
}

/// A registry or ownership sentence belongs to the subject only when it starts
/// with that name; a later mention can describe a competitor, parent or
/// namesake instead.
fn sentence_names_subject(sentence: &str, subject: &str) -> bool {
    let sentence = prose_key(sentence);
    sentence.starts_with(subject) || sentence.starts_with(&format!("the{subject}"))
}

fn company_facts(
    subject: &str,
    identity_references: &[Reference],
    sources: &[SourceRecord],
) -> CompanyFacts {
    let subject_key = prose_key(subject);
    let mut facts = CompanyFacts::default();
    for source in model_sources(sources) {
        for excerpt in &source.excerpts {
            let Ok(value) = serde_json::from_str::<Value>(&excerpt.text) else {
                continue;
            };
            if value.get("data").is_some() {
                gleif_facts(&value, &subject_key, &source.id, &mut facts);
            } else if value.get("addresses").is_some() && value.get("cik").is_some() {
                sec_facts(&value, &subject_key, &source.id, &mut facts);
            }
        }
    }
    facts.registry_record = registry_quote(identity_references, &subject_key);
    facts.founding = ownership_sentence(sources, &subject_key, &FOUNDING_MARKERS);
    facts.ownership = ownership_sentence(sources, &subject_key, &OWNERSHIP_MARKERS);
    facts
}

/// A resolved identity's own evidence may state the legal record in prose
/// rather than as a structured registry field. Carry that literal quotation
/// rather than parsing names out of arbitrary source text.
fn registry_quote(references: &[Reference], subject: &str) -> Option<Fact> {
    const REGISTRY_MARKERS: [&str; 6] = [
        "registration",
        "legal entity",
        "company number",
        "incorporated",
        "headquarters",
        "registered office",
    ];
    references
        .iter()
        .find(|reference| {
            let quote = reference.quote.to_lowercase();
            if quote.contains("domain") && !quote.contains("registered office") {
                return false;
            }
            REGISTRY_MARKERS.iter().any(|marker| quote.contains(marker))
                || (quote.contains("registered") && matches_subject(&reference.quote, subject))
        })
        .map(|reference| Fact {
            statement: statement(reference.quote.clone()),
            source_id: reference.source_id.clone(),
            anchors: vec![prose_key(&reference.quote)],
        })
}

fn gleif_facts(value: &Value, subject: &str, source_id: &str, facts: &mut CompanyFacts) {
    let Some(records) = value["data"].as_array() else {
        return;
    };
    for record in records {
        let Some(entity) = record.pointer("/attributes/entity") else {
            continue;
        };
        let name = entity
            .pointer("/legalName/name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !matches_subject(name, subject) {
            continue;
        }
        facts.legal_name.get_or_insert_with(|| Fact {
            statement: statement(format!(
                "The registered legal name is {}",
                name.trim_end_matches(['.', ','])
            )),
            source_id: source_id.to_owned(),
            anchors: vec![prose_key(name)],
        });
        let registered_as = entity
            .get("registeredAs")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let jurisdiction = entity
            .get("jurisdiction")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !registered_as.is_empty() {
            facts.registration.get_or_insert_with(|| Fact {
                statement: format!(
                    "The company is registered as {registered_as}{}.",
                    if jurisdiction.is_empty() {
                        String::new()
                    } else {
                        format!(" in {jurisdiction}")
                    }
                ),
                source_id: source_id.to_owned(),
                anchors: vec![prose_key(registered_as)],
            });
        }
        if let Some(address) = entity.get("legalAddress")
            && let Some((value, anchors)) = address_line(address)
        {
            facts.address.get_or_insert(Fact {
                statement: format!("The registered address is {value}."),
                source_id: source_id.to_owned(),
                anchors,
            });
        }
        break;
    }
}

fn sec_facts(value: &Value, subject: &str, source_id: &str, facts: &mut CompanyFacts) {
    let name = value["name"].as_str().unwrap_or_default();
    if !matches_subject(name, subject) {
        return;
    }
    let cik = value["cik"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| value["cik"].as_u64().map(|cik| format!("{cik:010}")))
        .unwrap_or_default();
    let jurisdiction = value["stateOfIncorporationDescription"]
        .as_str()
        .filter(|value| !value.is_empty())
        .or_else(|| {
            value["stateOfIncorporation"]
                .as_str()
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_default();
    if !name.is_empty() {
        facts.legal_name.get_or_insert_with(|| Fact {
            statement: statement(format!(
                "The registered legal name on the SEC record is {}",
                name.trim_end_matches(['.', ','])
            )),
            source_id: source_id.to_owned(),
            anchors: vec![prose_key(name)],
        });
    }
    if !cik.is_empty() {
        facts.registration.get_or_insert_with(|| Fact {
            statement: format!(
                "The company is registered with the SEC under CIK {cik}{}.",
                if jurisdiction.is_empty() {
                    String::new()
                } else {
                    format!(" and incorporated in {jurisdiction}")
                }
            ),
            source_id: source_id.to_owned(),
            anchors: vec![prose_key(&cik)],
        });
    }
    if let Some(address) = value.pointer("/addresses/business")
        && let Some((value, anchors)) = address_line(address)
    {
        facts.address.get_or_insert(Fact {
            statement: format!("The business address on the SEC record is {value}."),
            source_id: source_id.to_owned(),
            anchors,
        });
    }
}

/// Join one registry address object and return the anchors that prove the
/// section already carries it: its street line, else its city.
fn address_line(address: &Value) -> Option<(String, Vec<String>)> {
    let field = |name: &str| {
        address[name]
            .as_str()
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    let mut parts = Vec::new();
    if let Some(lines) = address["addressLines"].as_array() {
        parts.extend(
            lines
                .iter()
                .filter_map(Value::as_str)
                .filter(|line| !line.is_empty())
                .map(str::to_owned),
        );
    }
    for name in ["street1", "street2", "city"] {
        parts.extend(field(name));
    }
    parts.extend(field("region").or_else(|| field("stateOrCountry")));
    parts.extend(field("postalCode").or_else(|| field("zipCode")));
    parts.extend(field("country"));
    if parts.is_empty() {
        return None;
    }
    let mut anchors = Vec::new();
    for name in ["street1", "city"] {
        if let Some(value) = field(name) {
            anchors.push(prose_key(&value));
        }
    }
    if anchors.is_empty() {
        anchors.extend(
            address["addressLines"]
                .as_array()
                .and_then(|lines| lines.first())
                .and_then(Value::as_str)
                .map(prose_key),
        );
    }
    Some((parts.join(", "), anchors))
}

/// The first literal source sentence that carries an ownership or founding
/// record. New sentences are asserted as their source states them; the pass
/// never composes an ownership history from unrelated facts.
fn ownership_sentence(sources: &[SourceRecord], subject: &str, markers: &[&str]) -> Option<Fact> {
    for source in model_sources(sources) {
        for excerpt in &source.excerpts {
            if serde_json::from_str::<Value>(&excerpt.text)
                .is_ok_and(|value| value.is_object() || value.is_array())
            {
                continue;
            }
            for sentence in excerpt.text.split(['.', '!', '?', '\n']) {
                let sentence = sentence.trim();
                if !(20..=300).contains(&sentence.chars().count())
                    || !carries_marker(sentence, markers)
                    || sentence.to_lowercase().contains("does not establish")
                    // The company must be the sentence's subject. An ownership
                    // predicate about a competitor, parent or namesake never
                    // becomes this subject's history.
                    || !sentence_names_subject(sentence, subject)
                {
                    continue;
                }
                return Some(Fact {
                    statement: statement(sentence.to_owned()),
                    source_id: source.id.clone(),
                    anchors: vec![prose_key(sentence)],
                });
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn identity(kind: &str) -> Identity {
        Identity {
            kind: kind.into(),
            name: "Acme".into(),
            ..Default::default()
        }
    }

    fn source(id: &str, origin: &str, text: &str) -> SourceRecord {
        serde_json::from_value(json!({
            "id":id,"title":"Evidence","origin":origin,
            "access_state":"retrieved","source_type":"official_record",
            "excerpts":[{"text":text}],"notes":""
        }))
        .unwrap()
    }

    fn sec() -> SourceRecord {
        source(
            "s0",
            "SEC",
            &json!({
                "cik":"0000000111",
                "name":"ACME, INC.",
                "addresses":{"business":{"street1":"475 Brannan Street","city":"San Francisco","stateOrCountry":"CA","zipCode":"94107"}},
                "stateOfIncorporationDescription":"Delaware"
            })
            .to_string(),
        )
    }

    fn body(executive: &str, entity: &str) -> String {
        format!(
            "## Research context\n\nCollected evidence.\n\n## Executive assessment\n\n{executive}\n\n## Entity, ownership and history\n\n{entity}\n\n## Sources\n\nEvidence.\n"
        )
    }

    fn section<'a>(body: &'a str, title: &str) -> &'a str {
        body.split("\n## ")
            .find(|chunk| chunk.starts_with(&format!("{title}\n")))
            .unwrap()
            .strip_prefix(title)
            .unwrap()
    }

    #[test]
    fn company_sections_lead_with_the_company_and_record_missing_ownership() {
        let sources = [
            sec(),
            source(
                "s1",
                "Web",
                "Jane Smith was born in Ohio and studied history at State University.",
            ),
        ];
        let body = body(
            "Jane Smith was born in Ohio and studied history at State University. [s1]\n- Acme sells widgets to enterprises. [s1]",
            "Jane Smith was born in Ohio and studied history at State University. [s1]",
        );
        let mut limits = Vec::new();
        let repaired = enforce(
            &body,
            &identity("company"),
            &["Jane Smith".into()],
            &[],
            &sources,
            &mut limits,
        );
        let executive = section(&repaired, EXECUTIVE);
        assert!(executive.trim_start().starts_with("- Acme sells widgets"));
        let entity = section(&repaired, ENTITY);
        assert!(!entity.contains("born in Ohio"));
        assert!(entity.contains("ACME, INC."));
        assert!(entity.contains("0000000111"));
        assert!(entity.contains("475 Brannan Street"));
        assert!(entity.contains(OWNERSHIP_GAP));
        assert!(
            limits
                .iter()
                .any(|limit| limit.contains("does not establish ownership"))
        );
    }

    #[test]
    fn gleif_registration_and_registered_address_are_added() {
        let sources = [source(
            "s0",
            "GLEIF",
            &json!({"data":[{"attributes":{"entity":{
                "legalName":{"name":"ACME, INC."},
                "legalAddress":{"addressLines":["475 Brannan Street"],"city":"San Francisco","region":"CA","postalCode":"94107","country":"US"},
                "registeredAs":"1234567",
                "jurisdiction":"US-CA"
            }}}]})
            .to_string(),
        )];
        let mut limits = Vec::new();
        let repaired = enforce(
            &body("Acme sells widgets. [s0]", "Acme sells widgets. [s0]"),
            &identity("company"),
            &[],
            &[],
            &sources,
            &mut limits,
        );
        let entity = section(&repaired, ENTITY);
        assert!(
            entity.contains("registered as 1234567 in US-CA"),
            "{entity}"
        );
        assert!(
            entity
                .contains("registered address is 475 Brannan Street, San Francisco, CA, 94107, US"),
            "{entity}"
        );
    }

    #[test]
    fn retained_ownership_and_founding_facts_are_stated_with_their_citation() {
        let sources = [source(
            "s0",
            "Web",
            "Acme was founded by Jane Smith in 2012. Acme is a wholly owned subsidiary of Parent Holdings.",
        )];
        let mut limits = Vec::new();
        let repaired = enforce(
            &body("Acme sells widgets. [s0]", "Acme sells widgets. [s0]"),
            &identity("company"),
            &["Jane Smith".into()],
            &[],
            &sources,
            &mut limits,
        );
        let entity = section(&repaired, ENTITY);
        assert!(entity.contains("founded by Jane Smith in 2012. [s0]"));
        assert!(entity.contains("wholly owned subsidiary of Parent Holdings. [s0]"));
        assert!(!entity.contains(OWNERSHIP_GAP));
        assert!(
            !limits
                .iter()
                .any(|limit| limit.contains("does not establish ownership"))
        );
    }

    #[test]
    fn company_pass_is_idempotent() {
        let sources = [sec()];
        let mut limits = Vec::new();
        let once = enforce(
            &body(
                "Jane Smith was born in Ohio. [s1]",
                "Acme sells widgets. [s0]",
            ),
            &identity("company"),
            &["Jane Smith".into()],
            &[],
            &sources,
            &mut limits,
        );
        let twice = enforce(
            &once,
            &identity("company"),
            &["Jane Smith".into()],
            &[],
            &sources,
            &mut limits,
        );
        assert_eq!(once, twice);
        assert_eq!(limits.len(), 1);
    }

    #[test]
    fn a_company_without_company_level_evidence_gets_explicit_gaps() {
        let sources = [source("s0", "Web", "Jane Smith was born in Ohio.")];
        let mut limits = Vec::new();
        let repaired = enforce(
            &body(
                "Jane Smith was born in Ohio and studied history. [s0]",
                "Jane Smith was born in Ohio and studied history. [s0]",
            ),
            &identity("company"),
            &["Jane Smith".into()],
            &[],
            &sources,
            &mut limits,
        );
        let executive = section(&repaired, EXECUTIVE);
        assert!(executive.contains("does not establish a company-level assessment"));
        let entity = section(&repaired, ENTITY);
        assert!(entity.contains(OWNERSHIP_GAP));
        assert!(
            limits
                .iter()
                .any(|limit| limit.contains("company-level assessment"))
        );
        assert!(
            limits
                .iter()
                .any(|limit| limit.contains("does not establish ownership"))
        );
    }

    #[test]
    fn a_resolved_identity_registry_quotation_carries_the_text_legal_record() {
        let sources = [source("s0", "Web", "Unrelated prose.")];
        let references = [Reference {
            source_id: "s0".into(),
            quote: "Acme US Inc: registered legal entity US123, jurisdiction US-MA, headquarters 10 Main Street, Boston, US.".into(),
        }];
        let mut limits = Vec::new();
        let repaired = enforce(
            &body("Acme sells widgets. [s0]", "Acme sells widgets. [s0]"),
            &identity("company"),
            &[],
            &references,
            &sources,
            &mut limits,
        );
        let entity = section(&repaired, ENTITY);
        assert!(entity.contains("registered legal entity US123"), "{entity}");
        assert!(entity.contains("headquarters 10 Main Street"), "{entity}");
    }

    #[test]
    fn another_companys_ownership_never_becomes_the_subjects_history() {
        let sources = [source(
            "s0",
            "Web",
            "Widgets Inc is a wholly owned subsidiary of BigCo and competes with Acme.",
        )];
        let mut limits = Vec::new();
        let repaired = enforce(
            &body("Acme sells widgets. [s0]", "Acme sells widgets. [s0]"),
            &identity("company"),
            &[],
            &[],
            &sources,
            &mut limits,
        );
        let entity = section(&repaired, ENTITY);
        assert!(entity.contains(OWNERSHIP_GAP), "{entity}");
        assert!(entity.contains("does not establish ownership"), "{entity}");
    }

    #[test]
    fn an_empty_executive_assessment_opens_with_a_retained_company_fact() {
        let sources = [sec()];
        let mut limits = Vec::new();
        let repaired = enforce(
            &body("", "Acme sells widgets. [s0]"),
            &identity("company"),
            &[],
            &[],
            &sources,
            &mut limits,
        );
        assert!(
            section(&repaired, EXECUTIVE)
                .trim_start()
                .starts_with("- The registered legal name"),
            "{}",
            section(&repaired, EXECUTIVE)
        );
    }

    #[test]
    fn person_dossiers_are_untouched() {
        let sources = [sec()];
        let body = body(
            "Jane Smith founded Acme and leads it. [s0]",
            "Jane Smith is the founder and chief executive. [s0]",
        );
        let mut limits = Vec::new();
        assert_eq!(
            enforce(
                &body,
                &identity("person"),
                &["Jane Smith".into()],
                &[],
                &sources,
                &mut limits
            ),
            body
        );
        assert!(limits.is_empty());
    }
}
