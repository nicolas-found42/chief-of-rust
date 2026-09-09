# Live canary verification — 2026-09-06 UTC

All three canary entry points were exercised: Content Scout, public search, and
Person Profiles. These are diagnostic checks. Completing a run does not mean
that every external service returned useful data.

## Content Scout

[GitHub Actions run 34008061033](https://github.com/nicolas-found42/chief-of-staff-demo/actions/runs/34008061033)
ran on main at `0ecd8a198f1251bd6c8546cac2a8816f45eccc03`. The real Docker
image built and the live job completed successfully. Nine adapter objects compose
into eight collecting adapters with three targets each; the ninth is the
Substack enrichment helper, which has no independent targets.

| Adapter | Observations from the 24-target GitHub run |
| --- | --- |
| RSS | BBC: 26 items; New York Times: 15; NASA: HTTP 429 |
| Substack RSS | All three targets: HTTP 403 |
| Website | Example, Mozilla, Wikipedia: one item each |
| YouTube | All three: disconnected Google access, as configured on GitHub |
| Reddit | Programming: six items; technology and science: HTTP 429 |
| Instagram | NASA, National Geographic, BBC: each reached its 180-second timeout |
| TikTok | Charli: three items; Khaby and Addison: legitimate empty results |
| LinkedIn | All three initially hit the same renderer navigation race; fixes below |

The live step took about 9 minutes 17 seconds. The three Instagram timeouts
accounted for about nine minutes. This is a measured external-service limitation;
shortening the timeout or declaring these checks successful would hide it.

### Persistence and workflow checks

- The workflow restored the previous cache from run 33698534932.
- History increased from 408 to 432 receipts.
- Every old receipt was retained, verified by comparing receipt multisets.
- Exactly 24 fresh receipts were added, matching the production adapter version
  and target inventory, and the flat artifact matched those new receipts exactly.
- The new cache key was `canary-receipts-refs/heads/main-34008061033`.
- Artifact `canary-receipts` (9981725238) contained both history and flat results.
- Both shell command blocks in the workflow passed ShellCheck with Bash syntax.

### Additional local coverage

The saved local Google configuration was used for read-only public-channel
requests. NASA returned no recent items, BBC News returned 12, and TED returned
two. This exercises authenticated YouTube collection in addition to the
intentional disconnected result on GitHub.

Substack enrichment was also invoked on live collected items. Heather Cox
Richardson returned 20 feed items; enriching one added page evidence and found
media. The Bulwark returned 20 items on its custom domain; the helper left the
item unchanged, as its supported URL check does not match that domain.
Stratechery returned no recent items, leaving no item to enrich. This is not a
claim that all three publishers support live enrichment.

### Bugs found and corrected

The original LinkedIn error was reproduced in the production image:
`page.content: Unable to retrieve content because the page is navigating and changing the content.`
Its SHA-256 matched the diagnostic recorded by GitHub. Chromium itself started
successfully; the failure was a client-side redirect interrupting the HTML read.

The renderer now retries only that navigation race and shares the original
15-second navigation budget with the landing-document wait. Tests cover a
successful retry, deadline exhaustion, the remaining wait budget, unrelated
errors, timeout classification, the five-megabyte limit, and browser cleanup.

The first live rerun also exposed a LinkedIn login wall returned with HTTP 999.
The adapter now recognizes login-wall evidence before treating an otherwise
unrecognized status as an internal failure. A regression test reproduces the
misclassification. LinkedIn remains Coming later: an access block is failed
evidence for promotion, even when the diagnostic machinery works correctly.

The final live rerun used the freshly rebuilt production image, without source
mounts. All three LinkedIn targets recorded `blocked_access`, with durations of
972 ms, 908 ms, and 413 ms; none recorded an internal failure.

Local validation passed: 1,900 unit tests across 173 files, typechecking, lint,
formatting, Knip, and 80 browser tests. The final image composed all nine adapter
objects with `--check`, booted successfully, and returned `{"ok":true}` from
`/api/health`. The Compose services started for verification were brought down.

## Public search

`node scripts/run-search-canaries.mjs` ran once against the real providers and
local SearXNG. Each of the three queries returned 24 merged results. Of 25
providers, 19 returned results on at least one query.

GDELT and Marginalia returned rate limits; Mojeek returned an anti-bot page.
Reddit RSS returned results once and then a rate limit. SearXNG initially had a
startup connection failure, then returned results on both remaining queries.
Other empty responses remained recorded as empty, rather than invented results.

## Person Profiles

`person-dossier-canary.mts` ran with the saved OpenRouter configuration and model
`inception/mercury-2.5-preview`, writing into a separate evidence directory.

| Person | Elapsed | Operations | Model calls | Sources | Cited claims | Result |
| --- | --- | --- | --- | --- | --- | --- |
| Simon Willison | 21.379 s | 8 | 1 | 1 | 7 | Incomplete: operation budget reached |
| Rich Hickey | 5.985 s | 8 | 0 | 0 | 0 | Incomplete: no usable identity-matched source |

The model call recorded 8,585 input characters and 9,738 output characters.
Token usage and billed cost were unavailable; character counts are not token or
cost estimates. Both canaries completed, but neither proves a complete profile.

## Evidence

Local raw logs and JSON are retained in the ignored
`.scratch/canary-verification/` directory, including GitHub artifacts, search
results, the Person Profile report, authenticated YouTube observations, and
LinkedIn reruns. No local credentials were copied into the repository or GitHub.
