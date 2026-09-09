# How the app reads LinkedIn — options, and what the sources actually say

Research for [#115](https://github.com/nicolas-found42/chief-of-staff-demo/issues/115). Written
2026-08-29 against `main` at `d4bf128`. Not a decision — the input to one.

Every factual claim below carries the URL it came from. Where a source could not be reached, or
where a claim rests on inference rather than a document, it is marked. Sections headed
**Unverified** are exactly that.

---

## The question, and why it is being asked now

The Relay-to-Modules map ([#12](https://github.com/nicolas-found42/chief-of-staff-demo/issues/12))
records that every Relay Workflow calling `scraping.reverseContact` has zero successful Runs. Two
unbuilt Modules are blocked behind the same unmade decision:

- **08 Content Research** ([#21](https://github.com/nicolas-found42/chief-of-staff-demo/issues/21)) —
  reads *other people's* recent LinkedIn posts and reports on what is resonating and why. Relay ran
  it twice: LinkedIn Post Analyzer (one profile, daily, 49 Runs, all `UNSCHEDULED`, none completed,
  and all a full year before the rest of the export — 2025-07-18 to 2025-09-04) and LI Content
  Researcher (eleven profiles plus Reddit, weekly, 5 Runs). Both called
  `scraping.reverseContact.post.fromProfileUrl`.
- **10 LinkedIn Engagement Tracker** ([#23](https://github.com/nicolas-found42/chief-of-staff-demo/issues/23)) —
  reads *the operator's own* recent posts and upserts a metrics ledger into a Sheet keyed on the
  LinkedIn activity URL. 30 Runs, **every one `FAILED`**, 2026-07-14 to 2026-08-12. Same
  `scraping.reverseContact.post.fromProfileUrl` call.

The direction differs — other people's posts versus the owner's own — and, as it turns out, that
difference decides everything, because LinkedIn's official surface treats the two completely
differently.

There is also a live third party to this decision that #115 does not name: Content Scout already
ships a `LinkedInComingLaterAdapter`
(`apps/server/src/modules/content-scout/adapters/linkedin.ts`) that is registered in the production
adapter set (`adapters/production.ts`) and is standing behind an evidence gate. Whatever is decided
here decides that adapter's fate too.

---

## 1. LinkedIn's official position

### 1.1 The permission tiers

LinkedIn's own access page is unambiguous about what a developer can have without asking:

> "Most permissions and partner programs require explicit approval from LinkedIn. Open Permissions
> are the only permissions that are available to all developers without special approval."
> — <https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access>

The complete set of Open Permissions, from that same page:

| Product | Permission | What it does |
| --- | --- | --- |
| Sign in with LinkedIn using OpenID Connect | `profile` | "Retrieve authenticated member's name, headline, and photo." |
| Sign in with LinkedIn using OpenID Connect | `email` | "Retrieve authenticated member's primary email address." |
| Share on LinkedIn | `w_member_social` | "Post, comment and like posts on behalf of an authenticated member." |

That is the whole self-serve surface. **Nothing in it reads any post, by anyone, including the
authenticated member's own.** `w_member_social` writes only.

Everything else is gated:

- **Marketing / Advertising API** — "Developers seeking to build a marketing related integration
  using Advertising API permissions must be approved."
- **Sales Navigator (SNAP)** — the four `r_sales_nav_*` permissions require approval "as a Sales
  Navigator Application Platform (SNAP) partner". `r_sales_nav_profiles` is the one that returns
  "matched, publicly available member profile information" — and it is partner-gated.
- **Talent** — application required.
- **Compliance** — `r_compliance` / `w_compliance`: "Access is closed and may not be requested."

(all quotes from the same getting-access page)

### 1.2 Reading posts: the Posts API

The only documented read of posts is the Community Management API's Posts API. Its permission table
(<https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api>):

| Permission | Description |
| --- | --- |
| `r_organization_social` | "Retrieve organizations' posts, comments, and likes. Restricted to organizations in which the authenticated member has one of the following company page roles: ADMINISTRATOR, DIRECT_SPONSORED_CONTENT_POSTER, CONTENT_ADMIN" |
| `r_member_social` | "Retrieve posts, comments, and likes on behalf of an authenticated member. This permission is **restricted** and is available to **approved users only**." |

And on the author finder:

> "To retrieve all posts authored by a person, `r_member_social` permission is required."

`r_member_social` is not merely restricted — the Community Management overview FAQ closes it
outright:

> "**6. How do I get access to the Member Post Management program?** `r_member_social` is a
> **closed** permission. We're not accepting access requests at this time due to resource
> constraints."
> — <https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview>

**Consequence, stated plainly.** There is no LinkedIn API — open, vetted, or partner — that returns
*another individual member's* posts. `r_sales_nav_profiles` returns profile information, not posts,
and is SNAP-partner-gated. So **Content Research (#21) has no official route at all.** Not a hard
one; none.

For the owner's own posts, the official route runs through a closed permission. So **LinkedIn
Engagement Tracker (#23) has no official route through the Marketing stack either** — unless the
owner's posts are authored by the *company page* rather than the person, in which case
`r_organization_social` under the Community Management API applies. That product is "Vetted Product
with development and standard tiers", and the Standard Tier application requires "a screencast video
demonstrating each use case specified in your access request form" (same overview page). Its Page
Analytics includes Follower Statistics, Page Statistics, Share Statistics, Social Metadata
("reactions, comments on shares and posts") and Video Analytics — which is genuinely the engagement
ledger #23 wants, but for an organization's page, not a person's profile.

### 1.3 The one self-serve route to a member's own data: Member Data Portability

LinkedIn's DMA product line contains a route that is genuinely self-serve, and it is easy to miss:

> "the Member Data Portability (Member) product provides APIs that allow LinkedIn members to create
> an application to fetch that LinkedIn member's LinkedIn data."
> — <https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/member-data-portability-member/>

Access is requested from the developer portal ("From the Products tab of your application, click
**Request access** for **Member Data Portability API (Member)**"), the app must be created against
LinkedIn's own default company page, the scope is `r_dma_portability_self_serve`, and there is a
hard geographic gate:

> "At this time, this feature is available only for LinkedIn members located in the European
> Economic Area and Switzerland, so only those members are able to consent and generate an access
> token."
> — same page

Two APIs sit behind it. The **Member Snapshot API** returns historical data by domain
(<https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/shared/member-snapshot-api>,
pinned to `Linkedin-Version: 202312`). The relevant domains, quoted from
<https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/shared/snapshot-domain>:

| Domain | Description |
| --- | --- |
| `MEMBER_SHARE_INFO` | "Contains all shared or re-shared posts, including date, URL, shared comments, and visibility status." |
| `ARTICLES` | "Articles authored by the member." |
| `ALL_COMMENTS` | "Comments you've made, excluding those on posts in Groups." |
| `ALL_LIKES` | "Contains the reaction type a member has made to a post." |
| `INSTANT_REPOSTS` | "Contains the repost date, time and link." |

Read that carefully. `MEMBER_SHARE_INFO` gives the owner's posts with **date, URL and visibility** —
which is exactly the `activityUrl` key #23 upserts on — but **no engagement counts**. `ALL_LIKES`
and `ALL_COMMENTS` are reactions and comments *the member made*, not those *received*. Nothing in
the domain list returns impressions, reactions-received, or comments-received per post.

The **Member Changelog API** archives the member's interactions "from the time the user has
consented", queryable for "changelog events created in the past 28 days" only (member-data-portability
member page, above).

**Consequence.** Member Data Portability can give #23 the owner's post list and canonical activity
URLs, lawfully and self-serve, if the owner is in the EEA or Switzerland. It cannot give the
engagement metrics that are the whole point of the ledger.

### 1.4 The terms

**User Agreement**, effective November 3, 2025, § 8.2 "Don'ts"
(<https://www.linkedin.com/legal/user-agreement>) — the member agrees not to:

> "Develop, support or use software, devices, scripts, robots or any other means or processes (such
> as crawlers, browser plugins and add-ons or any other technology) to scrape or copy the Services"

> "Override any security feature or bypass or circumvent any access controls or use limits of the
> Services (such as search results, profiles, or videos)"

> "Copy, use, display or distribute any information (including content) obtained from the Services,
> whether directly or through third parties (such as search tools or data aggregators or brokers),
> without the consent of the content owner"

> "Use bots or other unauthorized automated methods to access the Services, add or download
> contacts, send or redirect messages, create, comment on, like, share, or re-share posts, or
> otherwise drive inauthentic engagement"

The third of those matters more than it first appears: it reaches data obtained **"through third
parties (such as search tools or data aggregators or brokers)"**. Buying LinkedIn-derived data from
a vendor is addressed by the User Agreement directly, not only by the vendor's own terms.

**API Terms of Use**, last updated December 13, 2022, effective January 13, 2023 for existing
developers (<https://www.linkedin.com/legal/l/api-terms-of-use>; `legal.linkedin.com/api-terms-of-use`
301-redirects here):

> "You must not capture, copy, cache, or store any Content or any information expressed by the
> Content."

with narrow exceptions for Member Tokens and OAuth Access Tokens, and Profile Data storage requiring
"legally valid consent" and refreshable only when the Member actively uses the application. And:

> "Access, store, display, or facilitate the transfer of any LinkedIn content obtained through the
> following methods: scraping, crawling, spidering or using any other technology or software to
> access LinkedIn content outside the APIs."

**robots.txt** — this one is decisive for Content Scout and is worth quoting in full at the top
(<https://www.linkedin.com/robots.txt>, fetched 2026-08-29, 4,862 lines):

```
# Notice: The use of robots or other automated means to access LinkedIn without
# the express permission of LinkedIn is strictly prohibited.
# See https://www.linkedin.com/legal/user-agreement.
# LinkedIn may, in its discretion, permit certain automated access to certain LinkedIn pages,
# for the limited purpose of including content in approved publicly available search engines.
# If you would like to apply for permission to crawl LinkedIn, please email whitelist-crawl@linkedin.com.
```

and the final rule of the file:

```
User-agent: *
Disallow: /
```

`LinkedInBot` is `Allow: /`; `Googlebot` and a handful of others get long path-by-path Disallow
lists; and roughly two dozen named crawlers (`CCBot`, `Bytespider`, `Scrapy`, `Diffbot`,
`Meta-ExternalAgent`, …) are `Disallow: /`. Everything not named — which includes a headless
Chromium driven by this app — falls under `User-agent: *` and is disallowed from **every path on the
site**.

**Help centre** (<https://www.linkedin.com/help/linkedin/answer/a1341387>): LinkedIn "don't permit
the use of any third party software, including 'crawlers', bots, browser plug-ins, or browser
extensions that scrape, modify the appearance of, or automate activity on LinkedIn's website", and
members who use them "risk having their accounts restricted or shut down", while "prohibited tools
they're using may become non-operational without notice."

---

## 2. reverseContact

**It is alive. Its posts capability is not.** That distinction is the single most important finding
in this document, and it is the opposite of what #115's title assumes.

### 2.1 The service is operating

<https://reversecontact.com/> is live and trading as "The people and company data API for modern B2B
teams", with a working API playground, People/Company Search, Person/Company Enrichment and
Person/Company Social Data endpoints, and delivery by API, webhook, CSV and MCP. Published pricing
(<https://reversecontact.com/pricing>): free 7-day evaluation access; pay-as-you-go credits from
$100 with 12-month validity; custom annual pricing for high volume; and monthly datasets — Companies
$1,000/mo, Employees $2,000/mo, Jobs $3,000/mo, Full Datasets (Global) $8,000/mo. The page does not
state what one credit buys.

Terms of service (<https://www.reversecontact.com/legal/terms-of-services>): the operator is
**"Visum, a French société par actions simplifiée"**, governed by French law. Data comes from
"publicly available professional and business information through open-source intelligence
methodologies". Visum acts as independent controller over its data lake and the customer "must
establish their own lawful basis for processing retrieved personal data". Crucially:

> "Visum makes no representation, warranty, or guarantee that Customer's use of the Services or the
> Data complies with the terms of service … imposed by any third-party platform."

The risk of LinkedIn's User Agreement is explicitly the customer's, contractually. The customer may
use Data "internally within its own products and workflows in enriched, aggregated, or derived form"
but may not build redistribution services without authorization, and § 15 carries an indemnity
running from customer to Visum.

### 2.2 The posts capability was retired, with no replacement, ever

reverseContact's own platform-update guide
(<https://app.reversecontact.com/docs/public/guides/july-2026-platform-update>), quoted verbatim:

> "Three things are happening on July 1, 2026: All legacy `/enrichment` endpoints (the original RC
> API) will be permanently shut down. All V1 endpoints will be permanently shut down. **Activities
> endpoints will be discontinued, even those currently exposed under V2. They will not be replaced,
> on V2 or anywhere else.**"

The Activities endpoints it names, verbatim:

```
POST /v2/fetch/persons/posts/live
POST /v2/fetch/persons/comments/live
POST /v2/fetch/persons/reactions/live
POST /v2/fetch/companies/posts/live
POST /v2/fetch/post/live
POST /v2/fetch/posts/comments/live
```

The reason, in their words:

> "Spreading our attention across too many endpoint families slowed our ability to deliver the
> highest quality on what most customers actually rely on: B2B identity resolution. **Activities
> remain outside that focus and were retired.**"

The changelog carries the same, dated Mon, Jun 1, 2026, as v2.7.0
(<https://app.reversecontact.com/docs/public/changelog>):

> "We are focusing the platform on a single modern foundation, V2: on July 1, 2026 the legacy
> endpoints and Activities were shut down, while the Contact Email Finder was later reactivated as a
> separately gated V2 capability."

What stays: person and company Enrichment, Fetch, Resolve and Search; the gated Contact Email
Finder; free Check endpoints. Base URL `https://api.reversecontact.com/v2/`
(<https://app.reversecontact.com/docs/public/getting-started>).

### 2.3 This explains the Relay failures exactly

`scraping.reverseContact.post.fromProfileUrl` is a call to fetch a person's posts from a profile
URL — the shape of `POST /v2/fetch/persons/posts/live`, which was shut down on 1 July 2026. The
LinkedIn Engagement Tracker's Runs begin **2026-07-14** and every one failed (#23). The Workflow's
very first Run post-dates the shutdown. There was never a working window.

**Verified:** the retirement, its date, and that there will be no replacement. **Inferred, and
marked as such:** that this retirement is the specific cause of each Relay failure. The Relay export
is the only place a failure reason could be read, and the export's Run History (as summarised in #12,
#21 and #23) records status, not error text. The date alignment is strong; it is not a receipt.

**So "rebuild on reverseContact" is not an option that exists.** The vendor still sells identity
resolution, and would be a reasonable candidate for a person/company enrichment need — but the
capability both blocked Modules were built on has been withdrawn permanently by the vendor's own
published decision.

---

## 3. The legal landscape — hiQ Labs v. LinkedIn, precisely

hiQ is the case everyone cites and almost nobody states correctly. Read from the court records
themselves.

### 3.1 What the Ninth Circuit actually held (April 18, 2022)

*hiQ Labs, Inc. v. LinkedIn Corp.*, No. 17-16783 (9th Cir. Apr. 18, 2022),
<https://cdn.ca9.uscourts.gov/datastore/opinions/2022/04/18/17-16783.pdf>. From the court's own
summary:

> "On remand from the United States Supreme Court, the panel affirmed the district court's order
> **preliminarily enjoining** LinkedIn Corp. from denying hiQ Labs, Inc., a data analytics company,
> access to publicly available member profiles"

and the conclusion:

> "We AFFIRM the district court's determination that hiQ has established the elements required for a
> preliminary injunction and remand for further proceedings."

**This was a preliminary-injunction appeal, decided on likelihood of success — not a merits
judgment.** On the CFAA the panel held only that hiQ "raised a serious question as to whether the
CFAA 'without authorization' concept is inapplicable where, as here, prior authorization is not
generally required but a particular person — or bot — is refused access."

And the panel said, in terms, that this leaves every other theory intact:

> "Entities that view themselves as victims of data scraping are not without resort, even if the
> CFAA does not apply: state law trespass to chattels claims may still be available. And other
> causes of action, such as copyright infringement, misappropriation, unjust enrichment, conversion,
> **breach of contract**, or breach of privacy, may also lie."

On trespass specifically: "Although we do not decide the question … it may be that web scraping
exceeding the scope of the website owner's consent gives rise to a common law tort claim for
trespass to chattels, at least when it causes demonstrable harm."

The panel also preserved LinkedIn's technical defences: the injunction "does not preclude LinkedIn
from continuing to engage in 'technological self-help' against bad actors".

### 3.2 What happened next, which is the part that gets dropped

Docket: *hiQ Labs, Inc. v. LinkedIn Corp.*, No. 3:17-cv-03301-EMC (N.D. Cal.),
<https://www.courtlistener.com/docket/6071320/hiq-labs-inc-v-linkedin-corporation/>.

**Dkt. 404** (signed Oct 27, 2022; public refiling Nov 4, 2022) — "ORDER DENYING PLAINTIFF'S MOTION
FOR SUMMARY JUDGMENT; GRANTING IN PART AND DENYING IN PART DEFENDANT'S MOTION FOR SUMMARY JUDGMENT;
DENYING DEFENDANT'S MOTIONS TO EXCLUDE; AND GRANTING IN PART DEFENDANT'S MOTION FOR SANCTIONS"
(<https://storage.courtlistener.com/recap/gov.uscourts.cand.312704/gov.uscourts.cand.312704.404.0_1.pdf>).
Judge Chen held, at 12:

> "In sum, the relevant language of the User Agreement unambiguously prohibits hiQ's scraping and
> unauthorized use of the scraped data."

and rejected hiQ's parol-evidence argument, noting that LinkedIn's "failure to abide by or enforce
the Agreement, which perhaps gives rise to an affirmative defense, does not contradict or render
ambiguous the unambiguous terms of the Agreement."

Be precise about the disposition, because it cuts both ways (at 18):

> "the Court therefore DENIES LinkedIn's motion for summary judgment on the breach of contract claim
> as to hiQ's scraping and unauthorized use of data because there remains a genuine dispute of
> material facts for hiQ's waiver and estoppel defenses, but GRANTS the motion as to hiQ turkers'
> conduct."

So: contract terms prohibiting scraping are **enforceable and unambiguous**, hiQ **breached** them,
but LinkedIn did not win summary judgment on that count because hiQ's waiver/estoppel defences
raised fact questions for trial. LinkedIn *did* win summary judgment on the fake-account conduct.
The court also imposed spoliation sanctions, issuing permissive adverse-inference instructions
including that "hiQ's scrapers made at least fifty billion requests on LinkedIn's servers" (at 40).

**Dkt. 405** (Dec 6, 2022) — stipulation with proposed judgment and permanent injunction.
**Dkt. 406** (Dec 8, 2022) — "Order by Judge Edward M Chen granting 405 CONSENT JUDGMENT AND
PERMANENT INJUNCTION"
(<https://storage.courtlistener.com/recap/gov.uscourts.cand.312704/gov.uscourts.cand.312704.406.0.pdf>).
Verbatim:

> "2. Judgment in the amount of $500,000 USD is hereby entered against hiQ and in favor of LinkedIn."

> "a. The Prohibited Parties are immediately and permanently enjoined from accessing and using,
> whether directly or indirectly through a third party, intermediary, or proxy, the LinkedIn platform
> in violation of its User Agreement, including without limitation by (i) **using automated means to
> access and/or copy data from the LinkedIn platform, whether logged in to a LinkedIn account or
> not, without express written permission of LinkedIn**, (ii) creating or using accounts with fake
> identities; (iii) using the LinkedIn platform to develop a commercial service without the express
> written permission of LinkedIn"

with orders to permanently delete all scraping code, all LinkedIn-derived data and every listed S3
bucket, MongoDB collection and repository (Exhibit 1). The docket shows the case terminated
2022-12-09.

### 3.3 What to take from it

- hiQ did **not** establish that scraping public LinkedIn data is lawful. It established a serious
  question that one federal statute, the CFAA, does not reach it — at the preliminary-injunction
  stage.
- The theory that actually decided the case was **contract**, and the court found LinkedIn's
  anti-scraping terms unambiguous and breached.
- The company that "won" hiQ paid $500,000, was permanently enjoined from automated access "whether
  logged in to a LinkedIn account or not", and destroyed its data and code.
- A consent judgment binds hiQ, not the world. It is not precedent. But it is a very clear statement
  of what LinkedIn will pursue and what it settles for.

The phrase "logged in … or not" is worth dwelling on, because it is the exact distinction Content
Scout's clean-browser posture relies on. It did not save hiQ from the injunction.

**Two other cases, named but not read.** Vendors in this space have been sued and the suits have
ended: *Meta Platforms, Inc. v. Bright Data Ltd.*, No. 3:23-cv-00077 (N.D. Cal., filed 2023-01-06,
terminated 2024-02-26), <https://www.courtlistener.com/docket/66706470/meta-platforms-inc-v-bright-data-ltd/>;
*X Corp. v. Bright Data Ltd.*, No. 3:23-cv-03698 (N.D. Cal., filed 2023-07-26, terminated
2025-07-01), <https://www.courtlistener.com/docket/67637345/x-corp-v-bright-data-ltd/>. I confirmed
the dockets exist and their disposition dates; **I did not read the merits orders**, so nothing about
what they held is asserted here. Both concern Meta and X, not LinkedIn.

---

## 4. Alternatives

### 4.1 Official LinkedIn routes

| Route | Returns | Access | Fits #21? | Fits #23? |
| --- | --- | --- | --- | --- |
| Sign in with LinkedIn (OIDC) | Authenticated member's name, headline, photo, email | Self-serve | No | No |
| Member Data Portability (Member) | Owner's own posts with date, URL, visibility (`MEMBER_SHARE_INFO`); articles; own comments/reactions; 28-day changelog | **Self-serve**, scope `r_dma_portability_self_serve`, **EEA/Switzerland members only** | No | Partly — posts yes, engagement counts no |
| Community Management API | Organization posts, comments, reactions, follower/page/share statistics, social metadata, member post statistics | Vetted product, Development then Standard tier, screencast demo required | No | Only for a **company page**, not a personal profile |
| Posts API with `r_member_social` | Member's own posts | **Closed permission**, not accepting requests | No | No |
| Sales Navigator `r_sales_nav_profiles` | "matched, publicly available member profile information" | SNAP partner approval | No (profiles, not posts) | No |

### 4.2 Vendors

| Vendor | What it returns | Access model | Terms posture | Cost (published) |
| --- | --- | --- | --- | --- |
| **reverseContact / Visum** (<https://reversecontact.com>) | Person & company enrichment, search, resolve. **Posts/comments/reactions retired 2026-07-01, no replacement.** | Commercial API, key | "no representation … that Customer's use … complies with the terms of service … imposed by any third-party platform"; customer indemnifies | PAYG from $100; datasets $1k–$8k/mo |
| **Proxycurl** (<https://nubela.co/proxycurl/>) | — | — | — | **Defunct.** Own site: "Proxycurl is no longer in service. See NinjaPear, a data platform for customer data instead." No sunset date or explanation given. |
| **Bright Data** (<https://brightdata.com/products/datasets/linkedin>) | LinkedIn datasets: people profiles 123.5M+, companies 34.4M+, jobs 15.6M+, **posts 11.6M+ with "content, engagement metrics, timestamps"**; plus a real-time "LinkedIn Scraper API" | Dataset download (S3/GCS/Azure/Snowflake/SFTP) or scraper API | Claims collection "exclusively from publicly available online sources in compliance with applicable laws … including GDPR, CCPA"; ISO 27001, SOC 2 | "$250 for 100K records (approximately $0.0025 per record)"; subscription discounts |
| **Apify** (<https://apify.com/store?search=linkedin>) | A marketplace of third-party Actors, many advertising "No Cookies": *Profile Posts Scraper for LinkedIn* (apimaestro), *LinkedIn Profile Posts Scraper (No Cookies)* (harvestapi), *LinkedIn Post Reactions Scraper* (harvestapi), *Linkedin Post Scraper ✅ No cookies* (supreme_coder), plus profile, company and jobs scrapers | Pay-per-event Actors run on Apify's platform; some jobs Actors publish flat rates (~$0.40–$0.45 per 1,000 jobs) | Terms posture is per-Actor and per-author, not Apify's; the store page carries no legality statement | Mostly "Pay per event", rate not shown on the listing page |
| **Coresignal** (<https://coresignal.com/>) | 907M+ employee records, 70M+ company records, 475M+ job postings, via Company/Employee/Jobs/Agentic Search APIs and flat files. **No post-level content advertised.** | API or dataset licence | "Certified by Ethical Web Data Collection Initiative"; GDPR/CCPA badges; "Collects only publicly available, strictly business-related data." **Does not name LinkedIn as a source anywhere on its homepage.** | Not published |
| **People Data Labs** (<https://www.peopledatalabs.com/person-data>) | "Comprehensive workforce profiles"; enrich/search/autocomplete/clean APIs, data feeds via AWS/GCP/Snowflake/Databricks | API or feed licence | "Stay ahead of regulatory compliance with our industry-leading data practices" — no sourcing statement on this page | "We charge per match" — no rates published |
| **Unipile** (<https://www.unipile.com/linkedin-api/>) | Messaging, invitations, profile search, InMail, recruiting workflows on a **connected member account** | **Connection "via credentials, cookies, or Chrome extension"**; Unipile "acts as an independent technical intermediary that helps software publishers connect authenticated LinkedIn accounts" | Operates as the member, under the member's User Agreement | €5.00 per account/month, €49/mo minimum for up to 10 accounts |

**Say this plainly, because #115 asks for it.** Unipile, and every Apify Actor or tool that takes a
`li_at` cookie or a password, works by **authenticating as a LinkedIn member**. That is precisely
what Content Scout's stated posture forbids — "a clean anonymous public browser route … no login, no
imported cookies, no shared identity, no CAPTCHA bypass, and no proxy evasion"
(`adapters/linkedin.ts`). Any such option is out on posture grounds before cost or capability is
even discussed, and it also puts the workspace owner's own account at the risk LinkedIn's help
centre names: restriction or shutdown.

The dataset vendors (Bright Data, Coresignal, PDL) do not require the owner's identity, so they do
not break that posture. They collide with a different clause instead — User Agreement § 8.2's ban on
copying information from the Services "whether directly or **through third parties (such as search
tools or data aggregators or brokers)**". A dataset purchase does not route around the User
Agreement; it is named in it.

### 4.3 The route Content Scout already has, and why it fails

The `LinkedInComingLaterAdapter` proposes to reach three public URLs with a clean headless browser:
`linkedin.com/company/linkedin/posts/`, `linkedin.com/company/microsoft/posts/`, and
`linkedin.com/in/reidhoffman/recent-activity/all/`. Its evidence gate demands three representative
targets × two useful canaries on one adapter version, and treats login walls, empty shells and
shape changes as failed evidence.

The gate is well built and it is going to fail, for a reason no amount of canary evidence can fix:
all three URLs are under `User-agent: * / Disallow: /`. Content Scout's own Source Adapter research
sets the standard — "Respect robots directives and site terms; do not attempt CAPTCHA bypass or
stealth login" (`docs/research/content-scout-source-adapters.md:291`) — and LinkedIn's robots.txt
disallows every path to every unnamed agent. So the adapter cannot pass its own project's stated bar
regardless of what the pages return.

Two honest notes on that. First, the gate has recorded **zero** canary evidence to date; that is
read from the code path, not from a run log I inspected. Second, **the app does not currently check
robots.txt anywhere** — `playwrightBrowserRenderer` (`adapters/browser.ts`) fetches the URL
directly. The robots stance is written down in research, not enforced in code. That gap is worth
knowing about independently of this decision.

### 4.4 Manual export

LinkedIn offers members a self-service data download from account settings, and the DMA Member
product above is the API form of the same idea. A manual export is a real option for #23 — it is the
owner's own data, it involves no automated access, and it breaks no term. It is not an Intake: it
needs a person, so it fits the app's model badly. **I did not verify the current contents or field
set of the self-service export UI**; the snapshot-domain list in §1.3 is the closest documented
approximation and is the API's list, not the download's.

---

## 5. The no-LinkedIn option, taken seriously

This is not the fallback. On the evidence above it is the only option for #21 and most of #23, so
it deserves the design work rather than a shrug.

### 5.1 Content Research (#21) without LinkedIn

The job, from #21, is: *read what a set of people are publishing, work out what is resonating and
why, and say what the hook was.* LinkedIn was the surface, not the job. The Module can do that job
over the surfaces the app already reaches lawfully — and Content Scout already ships adapters for
every one of them (`adapters/production.ts`): RSS, Substack, Website (clean browser), YouTube (on
the Google connection, ADR-0016), Reddit, Instagram, TikTok.

Note that LI Content Researcher **already read Reddit alongside LinkedIn** (#21). The Module was
never LinkedIn-only in its wide cut.

What changes without LinkedIn:

- **The Source Target set changes shape.** Eleven LinkedIn profile URLs become eleven people's
  actual publishing surfaces — newsletters, blogs, podcasts, YouTube channels, Substacks — which
  Content Scout's Source Discovery Run is already designed to propose from the Brand Profile and
  approved Source Targets.
- **"What is resonating" loses its cheapest signal.** Reaction and comment counts on a LinkedIn post
  are a direct engagement number. RSS and a website give none. YouTube gives view counts through the
  Google connection. Reddit gives score and comment counts. So the signal survives on two of the
  surfaces and is lost on the rest, where the Module must reason from the material itself rather
  than from a metric.
- **The comment-drafting Step goes.** LinkedIn Post Analyzer drafted a comment to leave on the post
  (#21). Without the post there is nothing to comment on, and drafting a LinkedIn comment is
  Content Scout's Draft Target territory anyway.

What it becomes: a Module that watches a named set of people across the surfaces they actually
control, and reports on what is landing. That is close enough to Content Scout's existing job that
the grill on #21 should genuinely ask whether it is a separate Module at all, or a Content Scout
Source Target set with a different Output Adapter. **That question is for the grill, not for this
document.**

### 5.2 LinkedIn Engagement Tracker (#23) without LinkedIn

Harder, because LinkedIn is the subject and not merely an input. The ledger is
post → date → title → engagement metrics, keyed on activity URL.

Three honest shapes:

1. **Drop it.** 30 Runs, zero successes, and the capability it was built on has been permanently
   withdrawn by its vendor. Nothing was ever delivered by this Workflow. The bar for rebuilding a
   thing that never once worked should be high.
2. **Owner's own posts via Member Data Portability, without metrics.** Lawful, self-serve,
   EEA/Switzerland only. Gives the post list and the activity URLs — the Sheet's key column — but
   not the reactions, comments or impressions. A ledger of *what was posted and when*, which the
   owner could then annotate. Honest, and much less than was asked for.
3. **Company page instead of personal profile, via Community Management API.** If found42 posts as a
   Page and the owner is an ADMINISTRATOR, this is a fully-supported official route to real
   engagement analytics — Share Statistics, Social Metadata, Follower Statistics. It requires a
   vetted-product application with a screencast demo, and it tracks the Page, not the person. **I do
   not know whether found42 has a Page or whether the tracked posts were the person's or the Page's;
   that is a question for Nicolas, not something to infer.**

---

## 6. Fit against this app's rules

| Option | Capability for #21 / #23 | Access model | Terms posture | Fit with this app's credential rules |
| --- | --- | --- | --- | --- |
| **Rebuild on reverseContact** | **None.** Posts endpoints retired 2026-07-01, no replacement | — | — | Moot |
| **Member Data Portability (Member)** | #21 no; #23 partly (posts + URLs, no metrics) | Official OAuth, self-serve, EEA/CH only | LinkedIn's own product; fully within terms | **Poor fit as built.** ADR-0011 puts *the Google connection* in the Shell; ADR-0016 chose an existing connection over a new credential. This is a second OAuth client, a second consent screen, a second refresh token and a second expiry to model — the exact "second secret store and second place to explain in Settings" ADR-0016 rejected. It would need its own ADR, and it is not extensible to any other need |
| **Community Management API (Page)** | #21 no; #23 yes, for a company Page | Vetted product, two tiers, screencast review | Official; fully within terms | Same second-OAuth-connection cost, plus a partner application with a review LinkedIn may refuse |
| **Dataset vendor (Bright Data / Coresignal / PDL)** | #21 plausibly (Bright Data advertises posts with engagement metrics); #23 no — it is not a per-owner live ledger | Commercial API key | Vendor claims public-source compliance; **User Agreement § 8.2 reaches data obtained "through third parties (such as … data aggregators or brokers)"** | **Mechanically the best fit and legally the worst.** A single API key in Shell config is exactly the `notion` / `hubspot` / `guestProfile` pattern already built (`packages/shared/src/schemas.ts`, redacted through `secretHint` in `apps/server/src/config.ts`). Costs nothing new architecturally |
| **Member-authenticated vendor (Unipile, cookie Actors)** | Both, technically | Owner's LinkedIn credentials or session cookie | Member's own User Agreement; account restriction risk | **Out.** Breaks Content Scout's stated posture outright — no login, no imported cookies, no shared identity — and the hiQ injunction reaches automated access "whether logged in to a LinkedIn account or not" |
| **Content Scout clean public browser** | Both, in principle | No credential at all | **`User-agent: * / Disallow: /` on every path** | Perfect credential fit, unusable terms fit. Cannot pass the project's own "respect robots directives" standard |
| **No LinkedIn reading** | #21 yes, reshaped; #23 becomes one of three shapes in §5.2 | Existing adapters and the Google connection | Clean | **Best fit.** Adds no credential, no ADR, no Settings surface, and no second connection state for the Shell to model |

Two codebase notes that matter to any option involving a key:

- The app already has a **Module-scoped third-party credential pattern**, and it was created for
  exactly this class of need: `meeting-brief-generator.guestProfile` holds `{ endpoint, apiKey,
  lastVerifiedAt, lastCheckAt, lastCheckState, lastCheckDetail }`
  (`packages/shared/src/schemas.ts:166`). That is the shape Meeting Brief Generator used to ship
  guest lookups *after* dropping LinkedIn (#115). It is precedent in both directions: the pattern
  exists, and the last Module to face this question chose a generic enrichment endpoint over
  LinkedIn.
- `redactConfig` currently redacts `apiKey`, `google.clientSecret` and `notion.token` only
  (`apps/server/src/config.ts:203-230`); Module-scoped secrets under `modules.*` are not in the
  redacted projection at all. Any new Module secret inherits that gap. Not this ticket's problem,
  but worth naming.

---

## 7. Recommendation

**Stop reading LinkedIn. Retire the LinkedIn Source Adapter from "Coming later" to a stated
"not supported", and build both Modules without LinkedIn.**

Specifically:

1. **#21 Content Research — no LinkedIn.** There is no official API that returns another member's
   posts at any tier, the vendor the Workflow used has permanently retired the capability, every
   remaining vendor route runs into User Agreement § 8.2 either directly or via the third-party
   aggregator clause, and the clean-browser route is disallowed on every path by robots.txt. Rebuild
   the *job* — watch a named set of people, report what is resonating — over the Source Adapters
   already shipped. Let the grill decide whether it is its own Module or a Content Scout
   configuration.
2. **#23 LinkedIn Engagement Tracker — do not rebuild as specified.** The engagement metrics it
   ledgers are not obtainable for a personal profile by any lawful route available to this app. Put
   two reduced shapes to Nicolas: Member Data Portability for a posts-and-dates ledger without
   metrics (conditional on EEA/Switzerland residency), or the Community Management API against a
   found42 Page if one exists and he administers it. If neither appeals, close it. A Workflow with
   30 Runs and zero successes has never delivered anything, and rebuilding it faithfully is not
   possible anyway.
3. **Retire the `LinkedInComingLaterAdapter`'s gate.** Not because the gate is wrong — it is
   careful, correct work — but because it can never pass while the project holds itself to
   respecting robots directives, and leaving it as "Coming later" implies a route that reopens with
   more evidence. It does not reopen with more evidence. It reopens only if LinkedIn changes
   robots.txt or grants written permission.

### The strongest case against this recommendation

**Bright Data is a real option and I am declining it on a terms reading rather than a legal ruling.**

It publishes a LinkedIn posts dataset with engagement metrics at roughly $0.0025 per record, claims
collection exclusively from publicly available sources in compliance with GDPR and CCPA, holds ISO
27001 and SOC 2, and has been sued by two platforms without either case producing a judgment against
it that I have read. Buying a dataset requires no LinkedIn account, no cookie, no login, and no
crawl of linkedin.com by this app at all — so it breaks none of Content Scout's posture rules, and
it drops into the existing Shell secret pattern with no new architecture. It would unblock #21
essentially as designed, and possibly #23 too.

The case against my recommendation is therefore: *this app is a three-person local tool, not a
commercial data service; the User Agreement binds LinkedIn's members and this app is not accessing
LinkedIn; § 8.2's aggregator clause has not to my knowledge been tested against a good-faith
purchaser of a public-data set; and refusing a lawful commercial product because its upstream terms
disapprove is a stricter standard than the project applies to anything else.*

Three things weigh against that, and they are why I still recommend against it:

- The aggregator clause is not ambiguous about intent, and hiQ's district court showed this judge
  reading LinkedIn's § 8.2 language as unambiguous and enforceable rather than aspirational.
- The consent judgment reaches access "directly or indirectly through a third party, intermediary,
  or proxy". That is hiQ's injunction, binding only hiQ — but it is a precise statement of the
  position LinkedIn litigates from.
- Vendor durability is the practical argument, and it is the one this ticket exists because of.
  Proxycurl is gone. reverseContact retired the exact capability with 30 days' notice. Building the
  highest-usage unresolved Module on a fourth vendor in this category is building on the same sand
  that produced #115.

If Nicolas weighs the first two lightly, Bright Data is the answer for #21 and this document should
be re-read as recommending it, with the durability risk accepted explicitly and an Adapter boundary
drawn so the vendor can be swapped.

---

## 8. What I could not verify

- **That the reverseContact Activities retirement is the specific cause of each Relay failure.** The
  dates align exactly (shutdown 2026-07-01; #23's first Run 2026-07-14) and the endpoint shape
  matches, but the Relay export records Run status, not error text. Strong inference, not a receipt.
- **Whether Nicolas is a LinkedIn member located in the EEA or Switzerland.** The entire Member Data
  Portability route for #23 depends on it, and LinkedIn's gate is on the member's location, not the
  company's. Visum being French says nothing about this.
- **Whether found42 has a LinkedIn Page, whether Nicolas administers it, and whether the tracked
  posts were the person's or the Page's.** This decides whether the Community Management API route
  exists at all.
- **What one reverseContact credit costs or buys.** The pricing page states a $100 minimum for
  pay-as-you-go and publishes no per-credit rate or per-endpoint cost, other than the Contact Email
  Finder at "3 credits only when an email is found".
- **Apify per-Actor pricing.** Almost every LinkedIn Actor lists "Pay per event" with no rate on the
  store listing; only two jobs Actors published flat rates. I did not open individual Actor pages,
  and I did not verify any "No Cookies" claim — that claim is the Actor author's, not Apify's, and
  it is the load-bearing claim for posture.
- **Coresignal's and People Data Labs' sourcing.** Neither names LinkedIn on the pages I read.
  Coresignal's homepage gives no source attribution at all; PDL's person-data page gives no sourcing
  statement. Whether their records are LinkedIn-derived is widely assumed and I could not confirm it
  from either company's own pages. `https://coresignal.com/solutions/linkedin-data/` returned 404.
- **The merits of *Meta v. Bright Data* and *X Corp v. Bright Data*.** I confirmed both dockets and
  their termination dates on CourtListener; I did not read the orders. Nothing about what those
  courts held is asserted here.
- **The current contents of LinkedIn's self-service member data download.** §4.4 uses the Member
  Snapshot domain list as a proxy; the download UI may differ.
- **reverseContact's V2 field list.** The Person Social Data page advertises "247 fields" but
  enumerates only ten; `https://app.reversecontact.com/docs/public/api-reference/fetch/posts`
  returns "This documentation page does not exist yet", consistent with the retirement.
- **Whether the LinkedIn evidence gate has ever recorded a canary.** I read the gate's code, which
  reports "No LinkedIn canary evidence has been recorded yet" for an empty set; I did not inspect a
  workspace to confirm the stored set is in fact empty.
- **reverseContact's terms of service quotations** come via a summarising fetch of
  `https://www.reversecontact.com/legal/terms-of-services` rather than a raw read, unlike the
  platform-update guide and changelog which I extracted verbatim from the raw HTML. Treat the
  Visum/French-law and indemnity details as accurate in substance; re-read the document itself
  before relying on exact wording contractually.
