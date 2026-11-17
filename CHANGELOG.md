# Forever Healthy Evidence MCP — Change Log

### v1.0.16 — 2026-11-17

* **Support for Liquid AI:** its decision models (`d1-ultra`) for claim verification.
* **Drug label search:** find FDA labels on DailyMed by drug name, with the set ID to add or read them.
* **Improved Bright Data handling:** refused pages no longer raise alerts.
* **Improved handling of refusing and slow sites:** a service that a site refuses or that keeps timing out there is skipped for a while.
* **Improved web page conversion:** headings are kept complete.
* **Improved log viewer:** a server line with the overall health, and disk usage on the storage line.

### v1.0.0 — 2026-11-11

First public release.

* **Self-building source library:** papers by `pmid:` or `doi:`, FDA drug labels by `dailymed:`, trial records by `nct:` — stored on first use with metadata, abstract and, wherever it can be obtained, the full text as token-optimized Markdown. Retractions and correction notices are recorded; a retracted paper is marked not citable.
* **Full-text discovery:** PMC, Europe PMC, the publishers' text-and-data-mining links (Elsevier and Wiley with a token), Unpaywall, OpenAlex, CORE and an optional institutional proxy, looked up in parallel. A landing page that names its PDF has the PDF fetched.
* **Download cascade:** three stages with parallel requests in each — fetch (plain fetch and a fetch proxy), browsers (Playwright browser servers and a real Chrome), unlockers (ZenRows, Zyte, Bright Data) — each used only when configured. Failing targets are remembered and skipped for a while. `utilities/deploy.sh` sets up every configured stage from the project's `.env`.
* **Token-saving partial reads:** `fh_library_read` returns the outline, one section or the passages matching a query — never the whole document.
* **Claim verification:** `fh_verify_claim` checks one finding against one source with a decision model (Perplexity's Decider, local or cloud; Google; OpenAI), on the full text or the abstract; a repeated claim answers from the local cache in under 1 ms.
* **PubMed and ClinicalTrials.gov:** searches and records as compact rows, up to 97–98% fewer tokens than other PubMed and ClinicalTrials.gov MCP servers; repeated queries in milliseconds.
* **Web fetch:** `fh_fetch_url`, the standard fetch with a cache and the download cascade, page clutter removed — about 20% more relevant content per result.
* **Log viewer:** a terminal UI (`tui/run.sh`) that follows the server's log with fails, errors and alerts filters and shows the health of the decision model and every stage, and the library's counts.
* **Demo skill:** `/ev ingest` and `/ev verify` on any document that cites medical sources; a sample evidence review in `samples/`.
