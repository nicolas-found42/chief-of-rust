use chief_of_rust::judgments::{self, Evaluation, Judge, TypeSafe, Usage};
use serde_json::json;
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{method, path},
};

#[test]
fn unknown_options_missing_answers_and_inconsistent_probabilities_fail_closed() {
    let q =
        json!({"category":{"type":"choice","instructions":"Choose","criteria":{"a":"A","b":"B"}}});
    let good =
        json!({"type":"choice","choice":"a","confidence":1.0,"probabilities":{"a":1.0,"b":0.0}});
    let mut e = Evaluation {
        model: "fixture".into(),
        warnings: Vec::new(),
        answers: std::collections::BTreeMap::from([("category".into(), good.clone())]),
        usage: Usage::default(),
    };
    assert!(judgments::validate(&q, &e).is_ok());
    for bad in [
        json!({"type":"choice","choice":"c","confidence":1.0,"probabilities":{"a":1.0,"b":0.0}}),
        json!({"type":"choice","choice":"a","confidence":1.0,"probabilities":{"a":0.5,"b":0.5}}),
        json!({"type":"choice","choice":"a","confidence":1.0,"probabilities":{"a":0.9,"b":0.9}}),
        json!({"type":"noul","noul":1.0}),
    ] {
        e.answers.insert("category".into(), bad);
        assert!(judgments::validate(&q, &e).is_err());
    }
    e.answers.clear();
    assert!(judgments::validate(&q, &e).is_err());
    e.answers.insert("category".into(), good);
    e.warnings.push(json!("truncated"));
    assert!(judgments::validate(&q, &e).is_err());
}
#[test]
fn score_arithmetic_and_credential_bearing_endpoints_are_rejected() {
    let q = json!({"degree":{"type":"score","instructions":"Rate","criteria":["Calm","Some friction","Hostile"]}});
    let mut e = Evaluation {
        model: "fixture".into(),
        warnings: Vec::new(),
        answers: std::collections::BTreeMap::from([(
            "degree".into(),
            json!({"type":"score","score":1.0,"confidence":1.0,"probabilities":{"0":0.0,"1":1.0,"2":0.0}}),
        )]),
        usage: Usage::default(),
    };
    assert!(judgments::validate(&q, &e).is_ok());
    e.answers.get_mut("degree").unwrap()["score"] = json!(2.0);
    assert!(judgments::validate(&q, &e).is_err());
    for base in [
        "http://public.example",
        "https://user:secret@example.test",
        "https://example.test?token=secret",
        "https://example.test#secret",
    ] {
        assert!(TypeSafe::new("fixture", Some(base)).is_err());
    }
    assert!(TypeSafe::new("", None).is_err());
}
#[tokio::test]
async fn malformed_json_and_success_status_errors_do_not_become_valid_judgments() {
    for body in [
        "not json",
        "{\"error\":\"private diagnostic\"}",
        "{\"model\":\"fixture\",\"answers\":{}}",
    ] {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/systemone"))
            .respond_with(ResponseTemplate::new(200).set_body_string(body))
            .mount(&server)
            .await;
        let client = TypeSafe::new("fixture", Some(&server.uri())).unwrap();
        let result = client
            .evaluate(
                json!({"text":"safe"}),
                json!({"yes":{"type":"noul","instructions":"Is there text?"}}),
            )
            .await;
        assert!(result.is_err());
        assert!(
            !result
                .unwrap_err()
                .to_string()
                .contains("private diagnostic")
        );
    }
}
