---
name: deep-research-pdf
description: Produce a curated, verified reading list from first-person operator sources and render it as a polished PDF report. User-invoked only.
argument-hint: [research question]
disable-model-invocation: true
---

# Deep Research → PDF Report

> Invocation policy: This is a user-only skill. Claude Code and Codex must never select or invoke it automatically. Run it only when the user explicitly invokes `/deep-research-pdf` in Claude Code or `$deep-research-pdf` in Codex.

Produce a curated, verified reading list on the user's research question, then render it as a polished PDF. The defining feature of this skill is the authenticity bar: every source must be first-person (written or narrated by the operator themselves), with specific numbers and decisions — generic SEO listicles and ghostwritten content marketing get discarded.

## Step 1 — Frame the question

From the user's request, extract:

- The core question (e.g., "how did open-source developer tools reach their first 1,000 paying teams?")
- The underlying decision they're trying to make (e.g., "which go-to-market motion should we try first?"). Ask if unclear — the synthesis section of the report should answer this directly.
- Any context about the user/company that should bias source selection (their industry, business model, stage). Use what you know from the session; tailor at least one section of the report to their closest analogs.

## Step 2 — Fan out parallel research agents

Launch 4 parallel general-purpose agents in a single message, one per source-type "beat". Adapt beats to the topic; for business/growth research the proven set is:

- Founder/operator-written essays and company blogs — personal blogs, transparent company blogs, open-metrics posts
- X/Twitter + LinkedIn build-in-public — people posting their own revenue numbers, P&Ls, real-time milestones
- Podcasts, talks, and interviews with transcripts — operator narrating their own story (prefer transcript availability)
- Communities, newsletters with operator guest posts, and aggregated data — plus anything directly answering the user's underlying decision question

Each agent prompt MUST include:

- The research question and the authenticity bar verbatim: "EXTREMELY personal, first-person accounts from the operators themselves, with specific numbers, specific decisions, what they killed, mistakes, internal debates. NOT generic SEO listicles."
- An instruction to use WebSearch + WebFetch extensively (10+ searches) and to verify by fetching the actual content before including it
- 10–20 named candidate sources/people to investigate (seed with your own knowledge of the space)
- The required output format per source: title, author + role, URL, scope/range covered, 2–4 takeaways with the specific numbers/tactics, one-line "why it's authentic"
- An instruction to maintain an "investigated and discarded" list with reasons
- An instruction to tier results (Tier 1 verified gems / Tier 2 with caveats) and aim for 8–12 verified sources
- The closing line: "Return structured markdown; your final message is data for the orchestrator, not user-facing prose."

Practical access tips to pass along: X URLs usually fail unauthenticated — try `threadreaderapp.com/thread/<POST_ID>.html`; dead/broken sites → Wayback Machine; note paywalls explicitly.

## Step 3 — Synthesize

Merge the four result sets:

- Dedupe (the same canonical source often surfaces on multiple beats — merge takeaways, keep the richest version)
- Tier: "Must-reads" (exact match + strongest authenticity) → thematic sections → "cautionary mirror-images" (first-person failure accounts — always include these if found, they're often the most honest) → honorable mentions
- Write a synthesis section that directly answers the user's underlying decision question, citing the pattern across sources and the counter-cases
- Note access caveats (paywalls, TLS issues, removed posts) inline with each source

## Step 4 — Render the PDF

Copy the `template.html` below verbatim and fill in the content. Keep the structure: cover block → numbered sections → `.source` cards (use `.source.caution` for failure accounts, `.tag` chips for "Top pick"/"Closest analog" etc.) → dark `.synthesis` block → `.footer` with method note (how many passes, how many sources verified/discarded).

Write the filled HTML to `reports/<topic-slug>/report.html` under the current project (or `~/Documents/research/` if not in a project).

Render with headless Chrome (no dependencies needed on macOS):

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu \
  --no-pdf-header-footer \
  --print-to-pdf="<output-dir>/<Report-Name>.pdf" \
  "file://<output-dir>/report.html"
```

Fallbacks if Chrome is absent: pandoc → weasyprint → ask the user to open the HTML and print to PDF.

Confirm the PDF was written (file size > 0).

## Step 5 — Deliver

In chat, give the PDF path plus a short summary: the 3 must-reads and the one-paragraph answer to the user's underlying question. Don't repeat the whole report in chat — the PDF is the deliverable.

## Quality bar checklist

- Every included source was actually fetched/verified by an agent, not assumed from memory
- Sources are first-person; aggregators only included when they carry verbatim operator quotes/data (and labeled as such)
- Real numbers appear in the takeaways, not paraphrased vibes
- Failure/cautionary accounts are represented, not just survivor stories
- The discarded list exists (proves filtering happened)
- The synthesis answers the user's actual decision, including counter-cases

## `template.html`

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{{REPORT TITLE}}</title>
<style>
  @page { margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif;
    color: #1a1a2e;
    font-size: 10.5pt;
    line-height: 1.55;
    margin: 0;
  }
  .cover {
    padding: 60px 0 30px 0;
    border-bottom: 3px solid #1a1a2e;
    margin-bottom: 28px;
  }
  .cover .kicker {
    text-transform: uppercase; letter-spacing: 2.5px; font-size: 8.5pt;
    color: #e63946; font-weight: 700; margin-bottom: 14px;
  }
  .cover h1 { font-size: 26pt; line-height: 1.15; margin: 0 0 10px 0; letter-spacing: -0.5px; }
  .cover .subtitle { font-size: 12pt; color: #555; margin: 0 0 18px 0; }
  .cover .meta { font-size: 9pt; color: #888; }
  h2 {
    font-size: 14.5pt; margin: 30px 0 4px 0; letter-spacing: -0.3px;
    page-break-after: avoid; color: #1a1a2e;
  }
  h2 .num { color: #e63946; margin-right: 6px; }
  .section-lede { color: #555; font-size: 10pt; margin: 0 0 14px 0; font-style: italic; }
  .source {
    page-break-inside: avoid;
    border: 1px solid #e2e2ea; border-left: 4px solid #1a1a2e;
    border-radius: 6px; padding: 13px 16px; margin: 0 0 12px 0;
  }
  .source.caution { border-left-color: #e63946; }
  .source h3 { font-size: 11.5pt; margin: 0 0 2px 0; }
  .source .who { font-size: 9pt; color: #666; margin-bottom: 6px; }
  .source .url {
    font-family: "SF Mono", Menlo, monospace; font-size: 8pt;
    color: #2563eb; word-break: break-all; margin: 2px 0;
  }
  .source ul { margin: 7px 0 2px 0; padding-left: 18px; }
  .source li { margin-bottom: 3.5px; }
  .source .why {
    font-size: 9pt; color: #444; background: #f6f6f9;
    padding: 6px 9px; border-radius: 4px; margin-top: 8px;
  }
  .source .why b { color: #1a1a2e; }
  .tag {
    display: inline-block; font-size: 7.5pt; font-weight: 700; text-transform: uppercase;
    letter-spacing: 1px; padding: 2px 8px; border-radius: 10px;
    background: #1a1a2e; color: #fff; margin-left: 8px; vertical-align: middle;
  }
  .tag.red { background: #e63946; }
  .synthesis {
    background: #1a1a2e; color: #f1f1f4; border-radius: 8px;
    padding: 18px 22px; margin: 26px 0; page-break-inside: avoid;
  }
  .synthesis h2 { color: #fff; margin-top: 0; }
  .synthesis .num { color: #ff6b6b; }
  .synthesis li { margin-bottom: 6px; }
  .synthesis b { color: #ffd166; }
  .note {
    font-size: 9pt; color: #555; background: #fff8e6; border: 1px solid #f0e0b0;
    border-radius: 6px; padding: 10px 14px; margin: 14px 0;
  }
  strong { color: #000; }
  .footer { margin-top: 36px; padding-top: 12px; border-top: 1px solid #ddd; font-size: 8pt; color: #999; }
</style>
</head>
<body>

<div class="cover">
  <div class="kicker">Research Report · Verified Primary Sources</div>
  <h1>{{REPORT TITLE}}</h1>
  <p class="subtitle">{{One-sentence framing of the research question and the underlying decision it informs.}}</p>
  <div class="meta">Prepared for {{user}} · {{company}} · {{Month Year}} · Every source below was fetched and verified as first-person with real numbers; ghostwritten and SEO content was discarded.</div>
</div>

<!-- Repeat per section. Number sections 01, 02, ... -->
<h2><span class="num">01</span>{{Section title}}</h2>
<p class="section-lede">{{Optional one-line section framing, e.g. "If you only read three things: …"}}</p>

<!-- Repeat per source. Add class="caution" for failure accounts. -->
<div class="source">
  <h3>{{Author — "Title / one-line story"}} <span class="tag">{{Optional: Top pick / Closest analog / Primary source}}</span></h3>
  <div class="who">{{Role, company · scope/range covered · format notes (transcript available, etc.)}}</div>
  <div class="url">{{https://primary-url}}</div>
  <div class="url">{{https://companion-url (optional, with parenthetical note)}}</div>
  <ul>
    <li>{{Takeaway with the SPECIFIC numbers/tactics — bold the headline fact with <strong>.}}</li>
    <li>{{2–4 takeaways total.}}</li>
  </ul>
  <div class="why"><b>Why trust it:</b> {{First-person? Real numbers? Public track record? Named caveats/asterisks go here too.}}</div>
</div>

<!-- Optional callout for access tips / caveats -->
<div class="note">
  <strong>{{Note label:}}</strong> {{Access tips, paywall caveats, where the genre thins out, etc.}}
</div>

<!-- Final synthesis: answers the user's underlying decision question -->
<div class="synthesis">
  <h2><span class="num">0N</span>Synthesis — what the pattern actually says</h2>
  <ul>
    <li><b>{{Headline finding.}}</b> {{Evidence across sources.}}</li>
    <li><b>{{Second pattern.}}</b> {{…}}</li>
    <li><b>{{The counter-case matters:}}</b> {{Where the pattern breaks and what that implies.}}</li>
    <li><b>{{The failure modes:}}</b> {{From the cautionary accounts.}}</li>
  </ul>
</div>

<div class="footer">
  Compiled {{Month Year}} · {{N}} parallel research passes ({{beat names}}) · ~{{N}} sources verified by fetching primary content; ghostwritten/SEO content discarded.
</div>

</body>
</html>
```
