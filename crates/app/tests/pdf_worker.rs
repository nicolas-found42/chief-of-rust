//! PDF worker isolation seam: the real app binary extracts over stdio,
//! malformed input stays a structured error, oversized input never spawns.
use std::io::Write;

fn b64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let mut n = 0u32;
        for (i, b) in chunk.iter().enumerate() {
            n |= (*b as u32) << (16 - 8 * i);
        }
        let pad = 3 - chunk.len();
        for i in 0..4 - pad {
            out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
        for _ in 0..pad {
            out.push('=');
        }
    }
    out
}

fn worker_bin() -> std::path::PathBuf {
    let bin = env!("CARGO_BIN_EXE_chief-of-rust");
    assert!(
        std::path::Path::new(bin).exists(),
        "app binary missing for worker test"
    );
    bin.into()
}

fn build_test_pdf(text: &[u8]) -> Vec<u8> {
    let mut pdf = b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n".to_vec();
    pdf.extend_from_slice(format!("4 0 obj\n<< /Length {} >>\nstream\n", text.len()).as_bytes());
    pdf.extend_from_slice(text);
    pdf.extend_from_slice(b"\nendstream\nendobj\n");
    pdf
}

fn minimal_pdf() -> Vec<u8> {
    build_test_pdf(b"BT /F1 12 Tf 72 720 Td (Worker isolation proof) Tj ET")
}

fn run_worker(request: &serde_json::Value) -> (bool, serde_json::Value) {
    let mut child = std::process::Command::new(worker_bin())
        .arg("pdf-worker")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(request).unwrap())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    let parsed = serde_json::from_slice::<serde_json::Value>(&output.stdout)
        .unwrap_or(serde_json::Value::Null);
    (output.status.success(), parsed)
}

#[test]
fn worker_extracts_selectable_text_with_page_locators() {
    let (success, response) = run_worker(&serde_json::json!({
        "bytes_b64": b64(&minimal_pdf()),
        "page_offset": 0,
        "max_pages": 5,
    }));
    assert!(success);
    assert_eq!(response["total_pages"], 1);
    assert!(
        response["pages"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Worker isolation proof")
    );
}

#[test]
fn worker_reports_malformed_input_without_crashing() {
    let (success, response) = run_worker(&serde_json::json!({
        "bytes_b64": b64(b"not a pdf"),
        "page_offset": 0,
        "max_pages": 5,
    }));
    assert!(success);
    assert!(response["pages"].as_array().unwrap().is_empty());
    assert_eq!(response["error"], "not a PDF document");
}

#[test]
fn oversized_input_is_rejected_before_spawn() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let big = vec![b'A'; chief_of_rust::pdf::INPUT_MAX_BYTES + 1];
    let result = runtime.block_on(chief_of_rust::pdf::extract_isolated(&big, 0, 5));
    assert!(result.unwrap_err().to_string().contains("2 MB"));
}

/// fetch_url routes PDF bytes to the isolated worker with page locators
/// instead of slicing raw bytes as text.
#[tokio::test]
async fn fetch_url_extracts_pdf_through_isolated_worker() {
    let server = wiremock::MockServer::start().await;
    let mut pdf = build_test_pdf(b"BT (Annual filing summary) Tj ET");
    pdf.resize(600_000, b' ');
    let expected_hash = chief_of_rust::research::content_hash(&pdf);
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .respond_with(
            wiremock::ResponseTemplate::new(200)
                .set_body_bytes(pdf)
                .insert_header("content-type", "application/pdf"),
        )
        .mount(&server)
        .await;
    unsafe { std::env::set_var("CHIEF_COLLECT_PDF_TEST_BASE", server.uri()) };
    unsafe { std::env::set_var("CHIEF_PDF_WORKER_EXE", env!("CARGO_BIN_EXE_chief-of-rust")) };
    let target = format!("{}/filing.pdf", server.uri());
    let envelope = chief_of_rust::collect::run_collector(
        "fetch_url",
        &serde_json::json!({"url": target}),
        None,
    )
    .await
    .unwrap();
    unsafe { std::env::remove_var("CHIEF_COLLECT_PDF_TEST_BASE") };
    unsafe { std::env::remove_var("CHIEF_PDF_WORKER_EXE") };
    assert_eq!(
        server.received_requests().await.unwrap().len(),
        1,
        "The default fetch should admit a complete PDF within the existing worker cap"
    );
    assert_eq!(envelope.content_sha256, expected_hash);
    assert_eq!(envelope.limits["bytes"], 600_000);
    assert_eq!(envelope.status, chief_of_rust::collect::CollectorStatus::Ok);
    let pages = envelope.evidence["pages"].as_array().unwrap();
    assert_eq!(pages.len(), 1);
    assert_eq!(pages[0]["locator"], "page 1");
    assert!(
        pages[0]["text_excerpt"]
            .as_str()
            .unwrap()
            .contains("Annual filing summary")
    );
}
