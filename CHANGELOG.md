# Forever Healthy Evidence MCP — Change Log

### v1.1.0 — 2026-11-26

* **Complete cited-by lists:** `fh_citing_articles` lists the articles that cite a paper — follow-up trials, later meta-analyses, guidelines and comments — filtered by type and year. Complete lists from OpenAlex, where PubMed's own cover only PubMed Central.
* **Optimized web search:** `fh_web_search` replaces the model's built-in web search — links with a short passage from each page, from several search providers at once, with up to 95% fewer tokens. Offered when a provider key is set (`FH_WEB_SEARCH_EXA_API_KEY`, `FH_WEB_SEARCH_SERPER_API_KEY`, `FH_WEB_SEARCH_BRAVE_API_KEY`).

* **Full texts for papers first seen in a PubMed batch:** reading or verifying a paper stored by `fh_pubmed_fetch_articles` now fetches its full text, as for a new paper.
* **Fast abstract reads:** `fh_library_read` with `abstract_only: true` reads just the abstract, in milliseconds, without a full-text download.
* **Improved claim verification on PDFs with lost symbols:** when a PDF's font lost the minus, ± or ≤ next to a claim's number, `fh_verify_claim` checks the claim again and answers `unverifiable` instead of a wrong `not_supported`.
* **Clearer verdicts:** `fh_verify_claim` answers `supported`, `not_supported` or `unverifiable` (was `pass` / `fail`); verdicts cached before are judged again.
* **Faster `fh_info`:** it answers without waiting for the library to be counted and no longer holds up other calls; the counts carry their time (`counted`) and are refreshed in the background, up to 10 minutes old.

* **Added Firecrawl as an unlocker** (`FH_FIRECRAWL_API_KEY`).

* **Named clients in the log:** `FH_CLIENT_NAME` names a project in the shared log (default: the host name), for several projects on one library; the log viewer shows the client column with `FH_CLIENT_SHOW=true` (was `FH_TUI_SHOW_CLIENT`, automatic by default).


### v1.0.17 — 2026-11-17

* **Clearer setup hint for claim verification:** without a decision model the error names `FH_VERIFY_PROVIDER` and its API key, and `/ev verify` stops at once instead of filling a table of 🟡.

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
