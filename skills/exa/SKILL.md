---
name: exa
description: "Use ONLY when the user explicitly asks to use Exa (exa.ai) — the AI web search / research / Websets API. Do NOT trigger for generic 'search the web' or 'research this' requests unless the user names Exa."
license: MIT
compatibility: "Requires uv."
allowed-tools:
  - "Bash(uv:*)"
  - "Write"
  - "Read"
---

# Exa

Call the [Exa](https://exa.ai) API — web search, contents extraction, answers, and Websets — from throwaway Python scripts.

## When to use this skill

Use this skill **only when the user explicitly asks for Exa** ("use exa", "search with exa", "run this through exa's websets", etc.). Do not reach for it on generic web-search or research asks — those have other tools.

## Non-negotiable rules

Read these before doing anything.

1. **NEVER read the API key.** The key lives in `.env` next to this file. Do **not** `cat`, `Read`, `head`, `tail`, `grep`, `echo`, or otherwise print `.env` or its contents. Never echo the key into a shell command, a log, or your reply. Only Python scripts load it — programmatically, and they must never print it.

2. **Sample first, scale second.** Before running thousands (or even dozens) of queries, run **one** query end-to-end, save the output, inspect the shape and quality, and confirm with the user. Never fire a large batch on the first attempt — it burns credits and rate limits if the request is malformed.

3. **Save results to files, never work from memory.** Every API call writes its raw JSON response to a file (e.g. `/tmp/exa_out/<name>.json`) as it arrives. Downstream steps read from those files. Do not accumulate results only in a script variable or in your context — a crash, a truncated response, or a long batch will lose them.

4. **Scripts go to `/tmp`.** Write your Python to `/tmp` (e.g. `/tmp/exa_run.py`), run it with `uv run /tmp/exa_run.py`, and keep it out of the repo.

## The pattern

The key is in `.env` inside this skill's directory (`<skill-dir>/.env`, next to this SKILL.md). Pass that file to your script; the script parses it and reads `EXA_API_KEY` without ever printing it.

Exa API basics:
- Base URL: `https://api.exa.ai`
- Auth header: `x-api-key: <EXA_API_KEY>`
- Common endpoints: `POST /search`, `POST /contents`, `POST /answer`, `POST /agent/runs` (see Docs below for the rest).
- **Exa Connect (connectors):** attach premium data partners (Similarweb, Fiber.ai, Baselayer, Financial Datasets, etc.) to an Agent run via `"dataSources": [{"provider": "similarweb"}]` on `POST /agent/runs`. Each partner call is billed on top of the run, so check pricing first: <https://exa.ai/docs/reference/agent-api/connect/overview.md>.

As thinking through your task - are any connectors needed?

### Step 1 — sample run (always do this first)

Write this to `/tmp/exa_run.py` and run it with **one** query. The first argument is `<skill-dir>/.env`.

```python
#!/usr/bin/env -S uv run --script
"""Exa sample runner. Never prints the API key. Writes raw responses to files."""
import json, os, sys, urllib.request

ENV_PATH = sys.argv[1]
OUT_DIR = "/tmp/exa_out"

def load_key(env_path):
    """Read EXA_API_KEY from the .env file without exposing it."""
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            if k.strip() == "EXA_API_KEY":
                return v.strip().strip('"').strip("'")
    sys.exit("EXA_API_KEY not found in .env")

def call(endpoint, payload, key):
    req = urllib.request.Request(
        f"https://api.exa.ai{endpoint}",
        data=json.dumps(payload).encode(),
        headers={"x-api-key": key, "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)

def main():
    key = load_key(ENV_PATH)          # loaded, never printed
    os.makedirs(OUT_DIR, exist_ok=True)

    # --- SAMPLE: one query only ---
    query = sys.argv[2] if len(sys.argv) > 2 else "latest AI research"
    result = call("/search", {"query": query, "numResults": 5, "type": "auto"}, key)

    out = os.path.join(OUT_DIR, "sample.json")
    with open(out, "w") as f:
        json.dump(result, f, indent=2)
    print(f"Saved {len(result.get('results', []))} results -> {out}")  # no key, no dump

if __name__ == "__main__":
    main()
```

Run:

```bash
uv run /tmp/exa_run.py <skill-dir>/.env "latest AI research"
```

Inspect the saved file (`/tmp/exa_out/sample.json`) — not stdout — to judge result quality.

### Step 2 — scale up (only after the sample looks right)

Reuse `load_key`/`call`. Loop over your inputs and **write each response to its own file as it returns** (`/tmp/exa_out/<slug>.json`). Add a short sleep and handle rate-limit / HTTP errors so one bad call doesn't drop the batch. Then read from the files for any downstream synthesis.

## Docs

- Main index: <https://exa.ai/docs/llms.txt>. Fetch it, then fetch the `.md` page you need.
- Context7 also has the docs: `/websites/exa_ai` (docs site), `/exa-labs/exa-py` (Python SDK), `/exa-labs/openapi-spec` (schemas).
