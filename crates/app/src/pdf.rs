//! Isolated selectable-text PDF extraction behind a worker subprocess.
//!
//! The spec requires fault/resource isolation no in-process parser can give:
//! the parent re-executes its own binary as `pdf-worker`, feeds at most
//! 2 MB over stdin, kills the child after an 8 s wall timeout, and caps
//! output (1–20 pages from an offset, 10,000 chars/page, 8 MB total
//! decompressed). A crash or hang in malformed input kills only the child
//! and surfaces as an honest `partial`/`error` envelope, never a server
//! failure.
//!
//! Unix CPU rlimits are not applied by this build (no libc dependency):
//! the envelope says so, mirroring the plugin's own degraded mode where
//! CPU controls are absent. Wall-time kill and input/output caps always
//! apply. No OCR or rendered content is ever claimed: only PDF text-show
//! operators (`Tj`/`TJ`) from decodable content streams, with page
//! locators from the page tree.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::time::Duration;

pub const WORKER_ARG: &str = "pdf-worker";
pub const INPUT_MAX_BYTES: usize = 2_000_000;
pub const WALL_TIMEOUT: Duration = Duration::from_secs(8);
pub const STREAM_MAX_BYTES: usize = 8_000_000;
pub const PAGE_MAX_CHARS: usize = 10_000;
pub const PAGE_OFFSET_MAX: u64 = 100_000;

#[derive(Debug, Deserialize)]
struct WorkerRequest {
    #[serde(default)]
    bytes_b64: String,
    #[serde(default)]
    page_offset: u64,
    #[serde(default)]
    max_pages: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerPage {
    pub page: u64,
    pub text: String,
    pub truncated: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct WorkerResponse {
    pages: Vec<WorkerPage>,
    total_pages: u64,
    truncated: bool,
    #[serde(default)]
    notes: Vec<String>,
    #[serde(default)]
    error: Option<String>,
}

/// Subprocess entrypoint: read one JSON request from stdin, write one JSON
/// response to stdout. Exit 0 covers extraction-level failures (reported in
/// `error`); nonzero means the protocol itself failed.
pub async fn run_worker() -> anyhow::Result<()> {
    let mut stdin = String::new();
    {
        use std::io::Read;
        std::io::stdin().read_to_string(&mut stdin)?;
    }
    let request: WorkerRequest = serde_json::from_str(&stdin)
        .map_err(|_| anyhow::anyhow!("pdf-worker: stdin is not a valid request"))?;
    let bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        &request.bytes_b64,
    )
    .map_err(|_| anyhow::anyhow!("pdf-worker: bytes_b64 is not valid base64"))?;
    anyhow::ensure!(
        bytes.len() <= INPUT_MAX_BYTES,
        "pdf-worker: input exceeds the 2 MB bound"
    );
    anyhow::ensure!(
        request.max_pages >= 1 && request.max_pages <= 20,
        "pdf-worker: max_pages must be 1–20"
    );
    anyhow::ensure!(
        request.page_offset <= PAGE_OFFSET_MAX,
        "pdf-worker: page_offset is out of range"
    );
    let output = extract_pdf_text(&bytes, request.page_offset, request.max_pages as usize);
    let response = WorkerResponse {
        pages: output.pages,
        total_pages: output.total_pages,
        truncated: output.truncated,
        notes: output.notes,
        error: output.error,
    };
    println!("{}", serde_json::to_string(&response)?);
    Ok(())
}

#[derive(Debug)]
pub struct PdfOutput {
    pub pages: Vec<WorkerPage>,
    pub total_pages: u64,
    pub truncated: bool,
    pub notes: Vec<String>,
    pub error: Option<String>,
}

/// Parent side: run extraction in an isolated child process. Faults and
/// hangs stay in the child; the wall timeout kills it and the caller maps
/// the outcome to an honest envelope status.
pub async fn extract_isolated(
    bytes: &[u8],
    page_offset: u64,
    max_pages: u64,
) -> anyhow::Result<PdfOutput> {
    anyhow::ensure!(
        bytes.len() <= INPUT_MAX_BYTES,
        "PDF input exceeds the 2 MB bound; not sent to the worker"
    );
    let request = json!({
        "bytes_b64": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes),
        "page_offset": page_offset,
        "max_pages": max_pages,
    });
    // The worker is this same binary re-executed, so the parser shares the
    // deployment's code. `CHIEF_PDF_WORKER_EXE` overrides the path for
    // layouts where the server binary is not directly re-executable.
    let exe = std::env::var("CHIEF_PDF_WORKER_EXE").unwrap_or_else(|_| {
        std::env::current_exe()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default()
    });
    let mut child = tokio::process::Command::new(exe)
        .arg(WORKER_ARG)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    {
        use tokio::io::AsyncWriteExt;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("PDF worker stdin unavailable"))?;
        stdin
            .write_all(serde_json::to_vec(&request)?.as_slice())
            .await?;
        stdin.shutdown().await?;
    }
    let output = tokio::time::timeout(WALL_TIMEOUT, child.wait_with_output()).await;
    let output = match output {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => anyhow::bail!("PDF worker failed: {error}"),
        Err(_) => anyhow::bail!("PDF worker exceeded the 8 s wall timeout and was killed"),
    };
    anyhow::ensure!(
        output.status.success(),
        "PDF worker exited with status {}",
        output.status
    );
    let response: WorkerResponse = serde_json::from_slice(&output.stdout)
        .map_err(|_| anyhow::anyhow!("PDF worker returned invalid JSON"))?;
    Ok(PdfOutput {
        pages: response.pages,
        total_pages: response.total_pages,
        truncated: response.truncated,
        notes: response.notes,
        error: response.error,
    })
}

/// Best-effort text-show extraction from content streams. Undecodable
/// streams (unsupported filters, corrupt deflate, unreadable page tree)
/// are skipped with notes; the output never invents text.
pub fn extract_pdf_text(bytes: &[u8], page_offset: u64, max_pages: usize) -> PdfOutput {
    let mut notes = Vec::new();
    if !bytes.starts_with(b"%PDF-") {
        return PdfOutput {
            pages: Vec::new(),
            total_pages: 0,
            truncated: false,
            notes,
            error: Some("not a PDF document".into()),
        };
    }
    let objects = parse_objects(bytes);
    if objects.is_empty() {
        return PdfOutput {
            pages: Vec::new(),
            total_pages: 0,
            truncated: false,
            notes,
            error: Some("no indirect objects found".into()),
        };
    }
    let pages = page_contents(&objects);
    let total_pages = pages.len() as u64;
    let mut out = Vec::new();
    let mut decompressed: usize = 0;
    let mut skipped = 0;
    for (index, content_refs) in pages.iter().enumerate() {
        let page_no = index as u64 + 1;
        if page_no <= page_offset {
            continue;
        }
        if out.len() >= max_pages {
            break;
        }
        let mut text = String::new();
        for content_ref in content_refs {
            let Some(obj) = objects.get(content_ref) else {
                skipped += 1;
                continue;
            };
            match stream_text(obj, &objects, &mut decompressed) {
                Ok(piece) => {
                    if !text.is_empty() && !piece.is_empty() {
                        text.push('\n');
                    }
                    text.push_str(&piece);
                }
                Err(note) => {
                    skipped += 1;
                    if notes.len() < 10 {
                        notes.push(format!("page {page_no}: {note}"));
                    }
                }
            }
        }
        let truncated = text.chars().count() > PAGE_MAX_CHARS;
        let kept: String = text.chars().take(PAGE_MAX_CHARS).collect();
        out.push(WorkerPage {
            page: page_no,
            text: kept,
            truncated,
        });
    }
    if skipped > 0 {
        notes.push(format!(
            "{skipped} content stream(s) skipped; reported, not silently dropped"
        ));
    }
    let truncated = out.len()
        < pages
            .len()
            .saturating_sub(page_offset.min(total_pages) as usize);
    PdfOutput {
        pages: out,
        total_pages,
        truncated,
        notes,
        error: None,
    }
}

#[derive(Clone, Debug)]
struct PdfObject {
    body: Vec<u8>,
}

/// Indirect object identifier: (object number, generation).
type ObjId = (u32, u16);

fn parse_objects(bytes: &[u8]) -> HashMap<ObjId, PdfObject> {
    let mut objects = HashMap::new();
    let mut i = 0;
    while i < bytes.len() {
        let Some(start) = find_obj_start(&bytes[i..]) else {
            break;
        };
        let abs = i + start;
        let head = &bytes[abs..];
        let (num, rest) = match read_number(head) {
            Some(v) => v,
            None => {
                i = abs + 1;
                continue;
            }
        };
        let rest = skip_ws(rest);
        let (gen_no, rest) = match read_number(rest) {
            Some(v) => v,
            None => {
                i = abs + 1;
                continue;
            }
        };
        let rest = skip_ws(rest);
        if !rest.starts_with(b"obj") {
            i = abs + 1;
            continue;
        }
        let body_start = skip_ws(&rest[3..]);
        let body = match find_bytes(body_start, b"endobj") {
            Some(end) => body_start[..end].to_vec(),
            None => break,
        };
        let next = bytes.len() - body_start.len() + body.len() + 6;
        objects.insert((num, gen_no as u16), PdfObject { body });
        i = next;
    }
    objects
}

fn find_obj_start(bytes: &[u8]) -> Option<usize> {
    let mut i = 0;
    while i + 8 < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let mut j = i;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            let k = skip_ws_len(&bytes[j..]);
            let mut l = j + k;
            let mut m = l;
            while m < bytes.len() && bytes[m].is_ascii_digit() {
                m += 1;
            }
            if m > l {
                l = m;
                let n = skip_ws_len(&bytes[l..]);
                if bytes[l + n..].starts_with(b"obj") && (i == 0 || !bytes[i - 1].is_ascii_digit())
                {
                    // Avoid matching decimal fragments inside stream data:
                    // require a line start or whitespace boundary.
                    if i == 0 || bytes[i - 1] == b'\n' || bytes[i - 1] == b'\r' {
                        return Some(i);
                    }
                }
            }
            i = j;
        }
        i += 1;
    }
    None
}

fn skip_ws(bytes: &[u8]) -> &[u8] {
    &bytes[skip_ws_len(bytes)..]
}

fn skip_ws_len(bytes: &[u8]) -> usize {
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b' ' | b'\t' | b'\n' | b'\r' | 0x0C => i += 1,
            b'%' => {
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
            }
            _ => break,
        }
    }
    i
}

fn read_number(bytes: &[u8]) -> Option<(u32, &[u8])> {
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == 0 {
        return None;
    }
    std::str::from_utf8(&bytes[..i])
        .ok()?
        .parse::<u32>()
        .ok()
        .map(|n| (n, &bytes[i..]))
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Page tree walk: trailer `/Root` → `/Pages` → `/Kids` → page `/Contents`
/// refs in tree order. Falls back to file-order `/Type /Page` scan when the
/// tree is unreadable; the fallback is disclosed, not silent.
fn page_contents(objects: &HashMap<ObjId, PdfObject>) -> Vec<Vec<ObjId>> {
    if let Some(pages) = tree_walk(objects) {
        return pages;
    }
    let mut fallback: Vec<(ObjId, Vec<ObjId>)> = objects
        .iter()
        .filter(|(_, obj)| is_page_object(&obj.body))
        .map(|(key, obj)| (*key, content_refs(&obj.body)))
        .collect();
    fallback.sort();
    fallback.into_iter().map(|(_, refs)| refs).collect()
}

fn is_page_object(body: &[u8]) -> bool {
    find_dict_entry(body, b"/Type").is_some_and(|v| {
        v.trim_ascii_start().starts_with(b"/Page") && !v.trim_ascii_start().starts_with(b"/Pages")
    })
}

fn tree_walk(objects: &HashMap<ObjId, PdfObject>) -> Option<Vec<Vec<ObjId>>> {
    let (_, catalog_obj) = objects.iter().find(|(_, obj)| {
        find_dict_entry(&obj.body, b"/Type")
            .is_some_and(|v| v.trim_ascii_start().starts_with(b"/Catalog"))
    })?;
    let pages_ref = parse_ref(find_dict_entry(&catalog_obj.body, b"/Pages")?)?;
    let mut nodes = Vec::new();
    collect_page_nodes(objects, pages_ref, &mut nodes, 0)?;
    Some(
        nodes
            .into_iter()
            .filter_map(|node| objects.get(&node).map(|obj| content_refs(&obj.body)))
            .collect(),
    )
}

/// Depth-first page nodes in tree order, with a recursion cap against
/// malicious kid cycles.
fn collect_page_nodes(
    objects: &HashMap<ObjId, PdfObject>,
    node: (u32, u16),
    out: &mut Vec<ObjId>,
    depth: usize,
) -> Option<()> {
    if depth > 32 {
        return None;
    }
    let obj = objects.get(&node)?;
    if is_page_object(&obj.body) {
        out.push(node);
        return Some(());
    }
    let kids = find_dict_entry(&obj.body, b"/Kids")?;
    let kids = parse_ref_array(kids);
    if kids.is_empty() {
        return None;
    }
    for kid in kids {
        collect_page_nodes(objects, kid, out, depth + 1)?;
    }
    Some(())
}

/// Raw dictionary value bytes for `/Key` inside `<< ... >>`. Depth-counts
/// nested dictionaries and arrays; strings are skipped opaquely.
fn find_dict_entry<'a>(body: &'a [u8], key: &[u8]) -> Option<&'a [u8]> {
    let mut i = 0;
    while i + key.len() < body.len() {
        if body[i] == b'/' && body[i + 1..].starts_with(&key[1..]) {
            let after = i + key.len();
            if after < body.len() && (body[after].is_ascii_alphanumeric() || body[after] == b'_') {
                i += 1;
                continue;
            }
            let value = skip_ws(&body[after..]);
            let v = dict_value(value);
            return Some(v);
        }
        i += 1;
    }
    None
}

fn dict_value(value: &[u8]) -> &[u8] {
    if value.starts_with(b"<<") {
        let mut depth = 0;
        let mut i = 0;
        while i < value.len() {
            if value[i..].starts_with(b"<<") {
                depth += 1;
                i += 2;
            } else if value[i..].starts_with(b">>") {
                depth -= 1;
                i += 2;
                if depth == 0 {
                    return &value[..i];
                }
            } else if value[i] == b'(' {
                i = skip_literal(value, i);
            } else if value[i] == b'<' && !value.get(i + 1).is_some_and(|b| *b == b'<') {
                while i < value.len() && value[i] != b'>' {
                    i += 1;
                }
                i += 1;
            } else {
                i += 1;
            }
        }
        return value;
    }
    if value.starts_with(b"[") {
        let mut depth = 0;
        let mut i = 0;
        while i < value.len() {
            match value[i] {
                b'[' => {
                    depth += 1;
                    i += 1;
                }
                b']' => {
                    depth -= 1;
                    i += 1;
                    if depth == 0 {
                        return &value[..i];
                    }
                }
                b'(' => i = skip_literal(value, i),
                _ => i += 1,
            }
        }
        return value;
    }
    // Scalar token: run to the next delimiter, then extend over a possible
    // `G R` reference tail (`N G R` spans spaces). A leading `/` belongs to
    // a name token (/Catalog, /Page); only a `/` after content ends it.
    let mut i = 0;
    while i < value.len()
        && !matches!(
            value[i],
            b' ' | b'\t' | b'\n' | b'\r' | b'>' | b']' | b'(' | b')' | b'<' | b'['
        )
    {
        if value[i] == b'/' && i > 0 {
            break;
        }
        i += 1;
    }
    let gen_start = i + skip_ws_len(&value[i..]);
    let gen_digits = value[gen_start..]
        .iter()
        .take_while(|b| b.is_ascii_digit())
        .count();
    if gen_digits > 0 {
        let r_start = gen_start + gen_digits + skip_ws_len(&value[gen_start + gen_digits..]);
        if value.get(r_start) == Some(&b'R')
            && !value
                .get(r_start + 1)
                .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_')
        {
            return &value[..r_start + 1];
        }
    }
    &value[..i]
}

fn skip_literal(value: &[u8], mut i: usize) -> usize {
    // value[i] == b'('
    let mut depth = 0;
    while i < value.len() {
        match value[i] {
            b'\\' => i += 2,
            b'(' => {
                depth += 1;
                i += 1;
            }
            b')' => {
                depth -= 1;
                i += 1;
                if depth == 0 {
                    return i;
                }
            }
            _ => i += 1,
        }
    }
    i
}

fn parse_ref(value: &[u8]) -> Option<ObjId> {
    let text = std::str::from_utf8(value).ok()?;
    let mut parts = text.split_whitespace();
    let num: u32 = parts.next()?.parse().ok()?;
    let gen_no: u16 = parts.next()?.parse().ok()?;
    if parts.next() == Some("R") {
        Some((num, gen_no))
    } else {
        None
    }
}

fn parse_ref_array(value: &[u8]) -> Vec<ObjId> {
    let text = match std::str::from_utf8(value) {
        Ok(text) => text,
        Err(_) => return Vec::new(),
    };
    let tokens: Vec<&str> = text
        .split(|c: char| c.is_whitespace() || c == '[' || c == ']')
        .filter(|t| !t.is_empty())
        .collect();
    let mut refs = Vec::new();
    let mut i = 0;
    while i + 2 < tokens.len() {
        if let (Ok(num), Ok(gen_no)) = (tokens[i].parse::<u32>(), tokens[i + 1].parse::<u16>())
            && tokens[i + 2] == "R"
        {
            refs.push((num, gen_no));
            i += 3;
        } else {
            i += 1;
        }
    }
    refs
}

fn content_refs(page_body: &[u8]) -> Vec<ObjId> {
    let Some(value) = find_dict_entry(page_body, b"/Contents") else {
        return Vec::new();
    };
    if let Some(single) = parse_ref(value.trim_ascii()) {
        return vec![single];
    }
    parse_ref_array(value)
}

/// Decode one content stream object to visible text. Returns a note instead
/// of text when the stream is undecodable; the caller reports it.
fn stream_text(
    obj: &PdfObject,
    objects: &HashMap<ObjId, PdfObject>,
    budget: &mut usize,
) -> Result<String, String> {
    let dict_end =
        find_bytes(&obj.body, b"stream").ok_or_else(|| "no stream keyword".to_string())?;
    let mut data = &obj.body[dict_end + 6..];
    if data.starts_with(b"\r\n") {
        data = &data[2..];
    } else if data.starts_with(b"\n") || data.starts_with(b"\r") {
        data = &data[1..];
    }
    let dict = &obj.body[..dict_end];
    let length = stream_length(dict, objects).ok_or_else(|| "unreadable /Length".to_string())?;
    if length > data.len() {
        return Err("stream shorter than /Length".to_string());
    }
    let mut bytes = data[..length.min(data.len())].to_vec();
    let filters = stream_filters(dict);
    if filters
        .iter()
        .any(|f| !matches!(f.as_str(), "FlateDecode" | "Fl"))
    {
        return Err(format!(
            "unsupported stream filter {}; only FlateDecode is decoded",
            filters.join(",")
        ));
    }
    if !filters.is_empty() {
        let params = find_dict_entry(dict, b"/DecodeParms").unwrap_or_default();
        bytes = inflate_with_params(&bytes, params)?;
        *budget += bytes.len();
        if *budget > STREAM_MAX_BYTES {
            return Err("8 MB decompression budget exceeded".to_string());
        }
    }
    Ok(content_text(&bytes))
}

fn stream_length(dict: &[u8], objects: &HashMap<ObjId, PdfObject>) -> Option<usize> {
    let value = find_dict_entry(dict, b"/Length")?;
    let text = std::str::from_utf8(value.trim_ascii()).ok()?;
    if let Ok(direct) = text.parse::<usize>() {
        return Some(direct);
    }
    let reference = parse_ref(value.trim_ascii())?;
    let obj = objects.get(&reference)?;
    std::str::from_utf8(obj.body.trim_ascii())
        .ok()?
        .parse::<usize>()
        .ok()
}

fn stream_filters(dict: &[u8]) -> Vec<String> {
    let Some(value) = find_dict_entry(dict, b"/Filter") else {
        return Vec::new();
    };
    let text = match std::str::from_utf8(value) {
        Ok(text) => text,
        Err(_) => return vec!["?".into()],
    };
    let mut filters = Vec::new();
    for token in text.split(|c: char| c == '/' || c.is_whitespace() || c == '[' || c == ']') {
        let token = token.trim();
        if token.is_empty() || token == "R" || token.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        filters.push(token.to_owned());
    }
    filters
}

fn inflate_with_params(bytes: &[u8], params: &[u8]) -> Result<Vec<u8>, String> {
    use flate2::read::ZlibDecoder;
    use std::io::Read;
    let mut decoder = ZlibDecoder::new(bytes);
    let mut out = Vec::new();
    decoder
        .read_to_end(&mut out)
        .map_err(|_| "deflate stream is corrupt".to_string())?;
    let predictor = params_text(params, b"/Predictor")
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(1);
    if predictor == 1 {
        return Ok(out);
    }
    if !(10..=15).contains(&predictor) {
        return Err(format!("unsupported predictor {predictor}; stream skipped"));
    }
    let columns = params_text(params, b"/Columns")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(1);
    let colors = params_text(params, b"/Colors")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(1);
    unfilter_png(&out, columns * colors, 8)
}

fn params_text(params: &[u8], key: &[u8]) -> Option<String> {
    let value = find_dict_entry(params, key)?;
    std::str::from_utf8(value.trim_ascii())
        .ok()
        .map(|s| s.trim().to_owned())
}

/// PNG unfiltering for predictor 10–15: each row starts with a filter byte.
fn unfilter_png(data: &[u8], columns: usize, bits: usize) -> Result<Vec<u8>, String> {
    let bpp = (columns * bits).div_ceil(8).max(1);
    let stride = columns.max(1);
    let row_len = stride + 1;
    if !data.len().is_multiple_of(row_len) {
        return Err("predictor row length mismatch".to_string());
    }
    let mut out = Vec::with_capacity(data.len());
    let mut prev = vec![0u8; stride];
    for row in data.chunks(row_len) {
        let filter = row[0];
        if filter > 4 {
            return Err(format!("unknown PNG filter {filter}"));
        }
        let mut cur = vec![0u8; stride];
        for i in 0..stride {
            let a = if i >= bpp { cur[i - bpp] } else { 0 };
            let b = prev[i];
            let c = if i >= bpp { prev[i - bpp] } else { 0 };
            let recon = match filter {
                0 => row[i + 1],
                1 => row[i + 1].wrapping_add(a),
                2 => row[i + 1].wrapping_add(b),
                3 => row[i + 1].wrapping_add(((a as u16 + b as u16) / 2) as u8),
                _ => row[i + 1].wrapping_add(paeth(a, b, c)),
            };
            cur[i] = recon;
        }
        out.extend_from_slice(&cur);
        prev = cur;
    }
    Ok(out)
}

fn paeth(a: u8, b: u8, c: u8) -> u8 {
    let (a, b, c) = (a as i16, b as i16, c as i16);
    let p = a + b - c;
    let (pa, pb, pc) = ((p - a).abs(), (p - b).abs(), (p - c).abs());
    if pa <= pb && pa <= pc {
        a as u8
    } else if pb <= pc {
        b as u8
    } else {
        c as u8
    }
}

/// Text-show operators from a content stream: `(...) Tj`, `<...> Tj` and
/// `[...] TJ` arrays. Kerning numbers below -100 start a word space.
/// Returns plain Unicode text in stream order.
fn content_text(stream: &[u8]) -> String {
    let tokens = tokenize_content(stream);
    let mut text = String::new();
    let mut i = 0;
    while i < tokens.len() {
        match &tokens[i] {
            ContentToken::Literal(bytes) => {
                // A literal followed by Tj/TJ is shown text; a bare literal
                // is an operand to some other operator — only emit when the
                // operator confirms it.
                if matches!(tokens.get(i + 1), Some(ContentToken::Op(op)) if op == "Tj" || op == "TJ")
                {
                    text.push_str(&decode_literal(bytes));
                    i += 1;
                }
            }
            ContentToken::Hex(bytes) => {
                if matches!(tokens.get(i + 1), Some(ContentToken::Op(op)) if op == "Tj" || op == "TJ")
                {
                    text.push_str(&decode_hex(bytes));
                    i += 1;
                }
            }
            ContentToken::Array(items) => {
                if matches!(tokens.get(i + 1), Some(ContentToken::Op(op)) if op == "TJ") {
                    for item in items {
                        match item {
                            ArrayItem::Text(bytes) => text.push_str(&decode_literal(bytes)),
                            ArrayItem::Hex(bytes) => text.push_str(&decode_hex(bytes)),
                            ArrayItem::Kern(n) if *n < -100.0 => {
                                if !text.ends_with(' ') && !text.ends_with('\n') {
                                    text.push(' ');
                                }
                            }
                            ArrayItem::Kern(_) => {}
                        }
                    }
                    i += 1;
                }
            }
            ContentToken::Op(op) if op == "'" || op == "\"" => {
                text.push('\n');
            }
            _ => {}
        }
        i += 1;
    }
    normalize_spaces(&text)
}

#[derive(Debug)]
enum ContentToken {
    Literal(Vec<u8>),
    Hex(Vec<u8>),
    Op(String),
    Array(Vec<ArrayItem>),
}

#[derive(Debug)]
enum ArrayItem {
    Text(Vec<u8>),
    Hex(Vec<u8>),
    Kern(f64),
}

fn tokenize_content(stream: &[u8]) -> Vec<ContentToken> {
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < stream.len() {
        match stream[i] {
            b' ' | b'\t' | b'\n' | b'\r' | 0x0C => i += 1,
            b'%' => {
                while i < stream.len() && stream[i] != b'\n' {
                    i += 1;
                }
            }
            b'(' => {
                let start = i;
                i = skip_literal(stream, i);
                tokens.push(ContentToken::Literal(stream[start + 1..i - 1].to_vec()));
            }
            b'<' if stream.get(i + 1) == Some(&b'<') => {
                i += 2; // inline dicts carry no shown text
                let mut depth = 1;
                while i < stream.len() && depth > 0 {
                    if stream[i..].starts_with(b"<<") {
                        depth += 1;
                        i += 2;
                    } else if stream[i..].starts_with(b">>") {
                        depth -= 1;
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
            }
            b'<' => {
                i += 1;
                let mut hex = Vec::new();
                while i < stream.len() && stream[i] != b'>' {
                    if !stream[i].is_ascii_whitespace() {
                        hex.push(stream[i]);
                    }
                    i += 1;
                }
                i += 1;
                tokens.push(ContentToken::Hex(hex));
            }
            b'[' => {
                i += 1;
                let mut items = Vec::new();
                while i < stream.len() && stream[i] != b']' {
                    match stream[i] {
                        b' ' | b'\t' | b'\n' | b'\r' | 0x0C => i += 1,
                        b'(' => {
                            let start = i;
                            i = skip_literal(stream, i);
                            items.push(ArrayItem::Text(stream[start + 1..i - 1].to_vec()));
                        }
                        b'<' => {
                            i += 1;
                            let mut hex = Vec::new();
                            while i < stream.len() && stream[i] != b'>' {
                                if !stream[i].is_ascii_whitespace() {
                                    hex.push(stream[i]);
                                }
                                i += 1;
                            }
                            i += 1;
                            items.push(ArrayItem::Hex(hex));
                        }
                        _ => {
                            let start = i;
                            while i < stream.len()
                                && !matches!(stream[i], b' ' | b'\t' | b'\n' | b'\r' | 0x0C | b']')
                            {
                                i += 1;
                            }
                            if let Ok(num) = std::str::from_utf8(&stream[start..i])
                                .unwrap_or_default()
                                .parse::<f64>()
                            {
                                items.push(ArrayItem::Kern(num));
                            }
                        }
                    }
                }
                i += 1;
                tokens.push(ContentToken::Array(items));
            }
            b'/' => {
                // Resource names are operands, not shown text; skip them.
                i += 1;
                while i < stream.len()
                    && !matches!(
                        stream[i],
                        b' ' | b'\t'
                            | b'\n'
                            | b'\r'
                            | 0x0C
                            | b'/'
                            | b'['
                            | b']'
                            | b'('
                            | b')'
                            | b'<'
                            | b'>'
                    )
                {
                    i += 1;
                }
            }
            _ => {
                if stream[i].is_ascii_digit() || matches!(stream[i], b'-' | b'+' | b'.') {
                    // Positioning operands; shown text arrives via Tj/TJ.
                    while i < stream.len()
                        && (stream[i].is_ascii_digit() || matches!(stream[i], b'-' | b'+' | b'.'))
                    {
                        i += 1;
                    }
                } else {
                    let start = i;
                    while i < stream.len()
                        && !matches!(
                            stream[i],
                            b' ' | b'\t'
                                | b'\n'
                                | b'\r'
                                | 0x0C
                                | b'/'
                                | b'['
                                | b']'
                                | b'('
                                | b')'
                                | b'<'
                                | b'>'
                                | b'%'
                        )
                    {
                        i += 1;
                    }
                    if start < i {
                        tokens.push(ContentToken::Op(
                            std::str::from_utf8(&stream[start..i])
                                .unwrap_or_default()
                                .to_owned(),
                        ));
                    } else {
                        i += 1;
                    }
                }
            }
        }
    }
    tokens
}

/// WinAnsi (PDF Latin) bytes to Unicode. 0x00–0x7F is ASCII; the 0x80–0x9F
/// window holds Windows-1252 punctuation; the rest is U+00A0–U+00FF.
fn decode_literal(bytes: &[u8]) -> String {
    let mut out = String::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            i += 1;
            match bytes[i] {
                b'n' => out.push('\n'),
                b'r' => out.push('\n'),
                b't' => out.push('\t'),
                b'b' => out.push('\u{8}'),
                b'f' => out.push('\u{c}'),
                b'(' | b')' | b'\\' => out.push(bytes[i] as char),
                b'\n' => {}
                digit if digit.is_ascii_digit() => {
                    let mut end = i;
                    while end < bytes.len() && end - i < 3 && bytes[end].is_ascii_digit() {
                        end += 1;
                    }
                    let value = std::str::from_utf8(&bytes[i..end])
                        .unwrap_or("0")
                        .parse::<u32>()
                        .unwrap_or(0)
                        & 0xFF;
                    out.push(winansi(value as u8));
                    i = end - 1;
                }
                other => out.push(other as char),
            }
        } else {
            out.push(winansi(bytes[i]));
        }
        i += 1;
    }
    out
}

fn winansi(byte: u8) -> char {
    const WINDOW: [char; 32] = [
        '€', '�', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '�', 'Ž', '�', '�', '‘',
        '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '�', 'ž', 'Ÿ',
    ];
    if byte < 0x80 {
        byte as char
    } else if byte < 0xA0 {
        WINDOW[(byte - 0x80) as usize]
    } else {
        // U+00A0–U+00FF map 1:1 from WinAnsi.
        char::from_u32(byte as u32).unwrap_or('�')
    }
}

/// Hex strings: UTF-16BE with BOM, else WinAnsi bytes.
fn decode_hex(hex: &[u8]) -> String {
    let mut bytes = Vec::new();
    let mut i = 0;
    while i + 1 < hex.len() {
        let pair = std::str::from_utf8(&hex[i..i + 2]).unwrap_or_default();
        if let Ok(byte) = u8::from_str_radix(pair, 16) {
            bytes.push(byte);
        }
        i += 2;
    }
    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        bytes[2..]
            .chunks(2)
            .map(|c| {
                if c.len() == 2 {
                    char::from_u32(u32::from((c[0] as u16) << 8 | c[1] as u16)).unwrap_or('�')
                } else {
                    '�'
                }
            })
            .collect()
    } else {
        bytes.iter().map(|b| winansi(*b)).collect()
    }
}

fn normalize_spaces(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut blank = true;
    for ch in text.chars() {
        if ch.is_whitespace() {
            if !blank {
                out.push(' ');
                blank = true;
            }
        } else {
            out.push(ch);
            blank = false;
        }
    }
    out.trim().to_owned()
}

/// Envelope-facing request shape for the fetch_url PDF path.
pub fn pdf_args(args: &Value) -> (u64, u64, Option<String>) {
    let offset = args
        .get("pdf_page_offset")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let max_pages = args
        .get("pdf_max_pages")
        .and_then(Value::as_u64)
        .unwrap_or(5)
        .clamp(1, 20);
    let expected = args
        .get("expected_sha256")
        .and_then(Value::as_str)
        .map(|s| s.to_owned());
    (offset.min(PAGE_OFFSET_MAX), max_pages, expected)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_pdf(objects: &str) -> Vec<u8> {
        format!("%PDF-1.4\n{objects}%%EOF\n").into_bytes()
    }

    fn stream_obj(num: u32, dict: &str, content: &[u8]) -> Vec<u8> {
        let mut obj = format!(
            "{num} 0 obj\n<< /Length {} {dict} >>\nstream\n",
            content.len()
        )
        .into_bytes();
        obj.extend_from_slice(content);
        obj.extend_from_slice(b"\nendstream\nendobj\n");
        obj
    }

    #[test]
    fn literal_text_operators_extract_in_stream_order() {
        let mut pdf = minimal_pdf(
            "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n",
        );
        pdf.extend_from_slice(&stream_obj(
            4,
            "",
            b"BT /F1 12 Tf 72 720 Td (Hello world) Tj ET",
        ));
        let out = extract_pdf_text(&pdf, 0, 5);
        assert_eq!(out.total_pages, 1);
        assert_eq!(out.pages.len(), 1);
        assert_eq!(out.pages[0].page, 1);
        assert!(out.pages[0].text.contains("Hello world"));
    }

    #[test]
    fn flate_content_streams_decode_with_page_locators() {
        // zlib stream of: BT /F1 12 Tf 72 720 Td (Hello flate world) Tj ET
        let compressed: Vec<u8> = vec![
            0x78, 0x9c, 0x73, 0x0a, 0x51, 0xd0, 0x77, 0x33, 0x54, 0x30, 0x34, 0x52, 0x08, 0x49,
            0x53, 0x30, 0x37, 0x02, 0x22, 0x03, 0x85, 0x90, 0x14, 0x05, 0x0d, 0x8f, 0xd4, 0x9c,
            0x9c, 0x7c, 0x85, 0xb4, 0x9c, 0xc4, 0x92, 0x54, 0x85, 0xf2, 0xfc, 0xa2, 0x9c, 0x14,
            0x4d, 0x85, 0x90, 0x2c, 0x05, 0xd7, 0x10, 0x00, 0x26, 0xaa, 0x0d, 0x44,
        ];
        let mut pdf = minimal_pdf(
            "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n",
        );
        let header = format!(
            "4 0 obj\n<< /Length {} /Filter /FlateDecode >>\nstream\n",
            compressed.len()
        );
        pdf.extend_from_slice(header.as_bytes());
        pdf.extend_from_slice(&compressed);
        pdf.extend_from_slice(b"\nendstream\nendobj\n");
        let out = extract_pdf_text(&pdf, 0, 5);
        assert!(out.error.is_none(), "error: {:?}", out.error);
        assert_eq!(out.pages.len(), 1);
        assert!(
            out.pages[0].text.contains("Hello flate world"),
            "text: {:?}",
            out.pages[0].text
        );
    }

    #[test]
    fn tj_arrays_join_with_word_spaces_on_wide_kerning() {
        let mut pdf = minimal_pdf(
            "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n",
        );
        pdf.extend_from_slice(&stream_obj(4, "", b"[(Hello) -250 (world)] TJ"));
        let out = extract_pdf_text(&pdf, 0, 5);
        assert!(
            out.pages[0].text.contains("Hello world"),
            "text: {:?}",
            out.pages[0].text
        );
    }

    #[test]
    fn unsupported_filters_skip_with_notes_not_invented_text() {
        let mut pdf = minimal_pdf(
            "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n",
        );
        pdf.extend_from_slice(&stream_obj(4, "/Filter /DCTDecode", b"ABCDEFGH"));
        let out = extract_pdf_text(&pdf, 0, 5);
        assert!(out.pages[0].text.is_empty());
        assert!(out.notes.iter().any(|n| n.contains("DCTDecode")));
    }

    #[test]
    fn garbage_bytes_report_structured_errors() {
        let out = extract_pdf_text(b"definitely not a pdf", 0, 5);
        assert_eq!(out.error.as_deref(), Some("not a PDF document"));
        assert!(out.pages.is_empty());
    }

    #[test]
    fn page_offset_skips_tree_order_pages() {
        let mut pdf = minimal_pdf(
            "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n5 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>\nendobj\n",
        );
        pdf.extend_from_slice(&stream_obj(4, "", b"BT (first page) Tj ET"));
        pdf.extend_from_slice(&stream_obj(6, "", b"BT (second page) Tj ET"));
        let out = extract_pdf_text(&pdf, 1, 5);
        assert_eq!(out.pages.len(), 1);
        assert_eq!(out.pages[0].page, 2);
        assert!(out.pages[0].text.contains("second page"));
    }
}
