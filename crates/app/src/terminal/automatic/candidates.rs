//! Collapse repeated extractions of one suggestion, without merging profiles.
use super::{Candidate, Identity, Reference};
use crate::research::SourceRecord;

fn compatible(a: &Identity, b: &Identity) -> bool {
    if a.kind != b.kind || !a.name.trim().eq_ignore_ascii_case(b.name.trim()) {
        return false;
    }
    for (left, right) in [(&a.linkedin, &b.linkedin), (&a.website, &b.website)] {
        if !left.is_empty()
            && !right.is_empty()
            && canonical_anchor(left) != canonical_anchor(right)
        {
            return false;
        }
    }
    [(&a.email, &b.email), (&a.jurisdiction, &b.jurisdiction)]
        .into_iter()
        .all(|(left, right)| {
            left.is_empty() || right.is_empty() || left.eq_ignore_ascii_case(right)
        })
}

/// Match repeated suggestions using a durable anchor or the same source span.
/// A name alone cannot join records for independently identified namesakes.
pub(super) fn same_suggestion(
    a: &Identity,
    a_refs: &[Reference],
    a_sources: &[SourceRecord],
    b: &Identity,
    b_refs: &[Reference],
    b_sources: &[SourceRecord],
) -> bool {
    if !compatible(a, b) {
        return false;
    }
    if same_candidate(a, b) {
        return true;
    }
    // A shared name/employer is insufficient. Repeated extraction must also
    // cite the same literal span at the same source URL. Source ids alone are
    // local to each Run and cannot establish equivalence across revisions.
    a_refs.iter().any(|left| {
        b_refs.iter().any(|right| {
            let url = |refs: &[SourceRecord], id: &str| {
                refs.iter()
                    .find(|s| s.id == id)
                    .and_then(|s| s.source_url.as_ref().or(s.request_url.as_ref()))
                    .map(|value| {
                        url::Url::parse(value)
                            .map(|mut url| {
                                url.set_fragment(None);
                                url.to_string()
                            })
                            .unwrap_or_else(|_| value.clone())
                    })
            };
            let Some(left_url) = url(a_sources, &left.source_id) else {
                return false;
            };
            if Some(left_url) != url(b_sources, &right.source_id) {
                return false;
            }
            let (left, right) = (left.quote.trim(), right.quote.trim());
            !left.is_empty()
                && (left == right
                    || (left.len().min(right.len()) >= 32
                        && (left.contains(right) || right.contains(left))))
        })
    })
}

fn compatible_record(a: &Candidate, b: &Candidate) -> bool {
    compatible(&a.identity, &b.identity)
        && (a.request_id.is_none() || b.request_id.is_none() || a.request_id == b.request_id)
}

/// Present existing duplicate suggestions together while retaining every record.
pub(super) fn groups(candidates: Vec<Candidate>) -> Vec<Vec<Candidate>> {
    let mut components: Vec<Vec<Candidate>> = Vec::new();
    for candidate in candidates {
        let mut joined = vec![candidate];
        let mut index = 0;
        while index < components.len() {
            if components[index].iter().any(|old| {
                joined.iter().any(|new| {
                    same_suggestion(
                        &old.identity,
                        &old.references,
                        &old.sources,
                        &new.identity,
                        &new.references,
                        &new.sources,
                    )
                })
            }) {
                joined.extend(components.remove(index));
                // A newly joined member can connect an earlier component.
                index = 0;
            } else {
                index += 1;
            }
        }
        components.push(joined);
    }
    components
        .into_iter()
        .flat_map(|component| {
            // Resolve ambiguity before assigning any sparse member. First-match
            // assignment can move its shared action state to a conflicting
            // namesake when rediscovery changes record ordering.
            if component
                .iter()
                .all(|a| component.iter().all(|b| compatible_record(a, b)))
            {
                vec![component]
            } else {
                component
                    .into_iter()
                    .map(|candidate| vec![candidate])
                    .collect()
            }
        })
        .collect()
}

/// Carry dismissal and an existing research request across all duplicate cards.
pub(super) fn representative(group: &[Candidate]) -> Candidate {
    // Every group is constructed with at least one member above.
    let mut candidate = group[0].clone();
    candidate.dismissed = group.iter().any(|member| member.dismissed);
    candidate.request_id = group.iter().find_map(|member| member.request_id.clone());
    candidate
}

pub(super) fn canonical_anchor(value: &str) -> String {
    // URL parsing normalizes scheme/host. Query, path case and fragment can
    // identify different profiles and must survive state-sharing comparisons.
    url::Url::parse(value)
        .map(|url| url.to_string())
        .unwrap_or_else(|_| value.to_owned())
}

pub(super) fn same_candidate(old: &Identity, new: &Identity) -> bool {
    if old.kind != new.kind || !old.name.eq_ignore_ascii_case(&new.name) {
        return false;
    }
    if old.kind == "person" {
        if !old.linkedin.is_empty()
            && !new.linkedin.is_empty()
            && canonical_anchor(&old.linkedin) != canonical_anchor(&new.linkedin)
        {
            return false;
        }
        (!old.linkedin.is_empty()
            && canonical_anchor(&old.linkedin) == canonical_anchor(&new.linkedin))
            || (!old.email.is_empty() && old.email.eq_ignore_ascii_case(&new.email))
            || (!old.website.is_empty()
                && canonical_anchor(&old.website) == canonical_anchor(&new.website))
    } else {
        !old.website.is_empty()
            && canonical_anchor(&old.website) == canonical_anchor(&new.website)
            && (old.jurisdiction.is_empty()
                || new.jurisdiction.is_empty()
                || old.jurisdiction.eq_ignore_ascii_case(&new.jurisdiction))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn candidate(id: &str, url: &str) -> Candidate {
        serde_json::from_value(json!({"id":id,"identity":{"kind":"person","name":"Alex Jones"},"reason":"Executive","references":[{"source_id":"s0","quote":"Alex Jones is an executive at Acme."}],"sources":[{"id":"s0","title":"Evidence","source_url":url,"access_state":"retrieved","source_type":"community","excerpts":[{"text":"Alex Jones is an executive at Acme."}],"notes":""}],"discovered_from":["company"],"dismissed":false,"request_id":null})).unwrap()
    }

    #[test]
    fn separate_query_records_and_research_requests_remain_independent() {
        let first = candidate("first", "https://example.org/people?id=1");
        let second = candidate("second", "https://example.org/people?id=2");
        assert_eq!(groups(vec![first.clone(), second]).len(), 2);
        let mut first = first;
        let mut second = candidate("second", "https://example.org/people?id=1");
        first.request_id = Some("first-request".into());
        second.request_id = Some("second-request".into());
        assert_eq!(groups(vec![first.clone(), second]).len(), 2);
        let mut duplicate = candidate("duplicate", "https://example.org/people?id=1");
        duplicate.dismissed = true;
        let grouped = groups(vec![first, duplicate]);
        assert_eq!(grouped.len(), 1);
        let shown = representative(&grouped[0]);
        assert!(shown.dismissed);
        assert_eq!(shown.request_id.as_deref(), Some("first-request"));
        assert_eq!(
            grouped[0].len(),
            2,
            "Every original evidence record is retained"
        );
    }

    #[test]
    fn shared_quotation_never_bridges_conflicting_identity_anchors() {
        let mut first = candidate("first", "https://example.org/team");
        let mut second = candidate("second", "https://example.org/team");
        let sparse = candidate("sparse", "https://example.org/team");
        first.identity.email = "alex1@example.org".into();
        second.identity.email = "alex2@example.org".into();
        let grouped = groups(vec![first, sparse, second]);
        assert_eq!(grouped.len(), 3);
        for group in grouped {
            let emails = group
                .iter()
                .filter_map(|c| (!c.identity.email.is_empty()).then_some(c.identity.email.as_str()))
                .collect::<std::collections::HashSet<_>>();
            assert!(emails.len() <= 1);
        }
    }

    #[test]
    fn ambiguous_sparse_membership_is_independent_of_record_order() {
        let mut first = candidate("first", "https://example.org/team");
        let mut second = candidate("second", "https://example.org/team");
        let sparse = candidate("sparse", "https://example.org/team");
        first.identity.email = "alex1@example.org".into();
        second.identity.email = "alex2@example.org".into();
        first.request_id = Some("first-request".into());
        first.dismissed = true;
        let records = [first, sparse, second];
        for order in [
            [0, 1, 2],
            [0, 2, 1],
            [1, 0, 2],
            [1, 2, 0],
            [2, 0, 1],
            [2, 1, 0],
        ] {
            let grouped = groups(order.map(|index| records[index].clone()).to_vec());
            assert_eq!(
                grouped.len(),
                3,
                "Ambiguous evidence must not carry state between namesakes"
            );
            for group in grouped {
                let shown = representative(&group);
                assert_eq!(shown.dismissed, shown.id == "first");
                assert_eq!(shown.request_id.is_some(), shown.id == "first");
            }
        }
    }

    #[test]
    fn identity_urls_preserve_query_path_case_and_fragments() {
        for (left, right) in [
            (
                "https://example.org/person?id=1",
                "https://example.org/person?id=2",
            ),
            ("https://example.org/Person", "https://example.org/person"),
            (
                "https://example.org/#/person/1",
                "https://example.org/#/person/2",
            ),
        ] {
            let mut first = candidate("first", "https://example.org/team");
            let mut second = first.clone();
            second.id = "second".into();
            first.identity.website = left.into();
            second.identity.website = right.into();
            first.references.clear();
            second.references.clear();
            assert_eq!(
                groups(vec![first, second]).len(),
                2,
                "Different identity URLs must stay separate"
            );
        }
    }
}
