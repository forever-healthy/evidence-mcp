![Version](https://img.shields.io/badge/Version-1.0.17-green.svg)
![License MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
[![Forever Healthy](https://img.shields.io/badge/(c)_2026-Forever_Healthy-573D7D.svg)](https://forever-healthy.org)
[![npm](https://img.shields.io/badge/npm-evidence--mcp-cb3837.svg)](https://www.npmjs.com/package/evidence-mcp)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-io.github.forever--healthy%2Fevidence--mcp-1f6feb.svg)](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.forever-healthy/evidence-mcp)

![Forever Healthy Evidence MCP](docs/evidence-git-header.png)

# Forever Healthy Evidence MCP

Power tools for AI agents to improve and speed up medical literature research. Developed while building [evipedia.ai](https://evipedia.ai) and experiencing the pain points and shortcomings of existing solutions.

Toolset:

- A self-building local library of sources: PMID, DOI, DailyMed, NCT
- Decider-based claim verification against those sources
- Optimized access to PubMed, ClinicalTrials.gov & DailyMed
- Optimized web fetch. 

All functions are token-optimized to minimize context use, return agent-ready content, and cache locally for fast responses. The MCP is self-explanatory to agents, so they can start using it right away with no coding required.

Released under the MIT license to empower, simplify, and speed up medical literature research for everyone.

## Evidence MCP Tools

### Self-Building, Local Source Library

- Builds itself as agents work
- Supports `pmid`, `doi`, `dailymed`, and `nct` IDs
- Local caching of metadata, abstract, and full text
- Token-saving partial reads: agents read the outline, then pick only the sections they need
- Full text fetched automatically wherever it can be obtained
- Parallel discovery cascade for full text (PMC, Europe PMC, TDM, Unpaywall, OpenAlex, CORE, institutional proxy)
- Support for Elsevier and Wiley TDM
- Automatic conversion (HTML, XML, PDF) to token-optimized Markdown

### Decider-Based Claim Verification

- Fast verification of claims against library sources using decider models
- Automatic choice of abstract or full text, depending on availability
- Local caching for repeat queries: a cached verdict in under 1 ms vs. ~1 s from the model
- Support for Perplexity, Google, OpenAI, and Liquid AI decision models

### Optimized PubMed Access

- Up to 97% fewer tokens than other PubMed MCPs (Anthropic's, cyanheads'): a 20-row search ~50–97% smaller, 20 records ~96% smaller
- Local caching: a repeated query in milliseconds instead of a second

### Optimized ClinicalTrials.gov Access

- Up to 98% fewer tokens than other ClinicalTrials.gov MCPs (Anthropic's, cyanheads'): a trial record ~97% smaller, a search ~40% smaller than Anthropic's
- Local caching: a repeated query in milliseconds instead of a second

### Optimized DailyMed Access

- FDA drug labels found by generic or brand name, narrowed to one manufacturer if needed: set ID, manufacturer, date and version per label
- 98% fewer tokens than DailyMed's search page
- Local caching: a repeated query in milliseconds

### Optimized Web Fetch

- Significantly higher success rate than the standard fetch
- 20% more relevant content per result than the standard fetch
- Local caching
- Automatic use of the download cascade

### Versatile Download Cascade

- Multi-stage download cascade for web pages and full texts
- Significantly higher success rate than the standard fetch
- Escalates stage by stage, with parallel requests in each: fetch, browsers, unlockers
- Fetch: plain fetch and a fetch proxy
- Browsers: Playwright browser servers and a real Chrome
- Unlockers: ZenRows, Zyte, Bright Data
- Remembers failing targets and services and skips them for a while
- Agent-deployable: comes with instructions for agents to set up and test every stage

### Local Caching

- All results cached locally where sensible
- Response times in milliseconds instead of seconds
- Extremely helpful when iterating multiple times over the same document
- Automatic cache and refresh management

### Log Viewer

- Python-based TUI for operations monitoring


## Tools

| Tool | |
|---|---|
| `fh_info()` | version, library counts by type and level, sources, browsers, decider, configuration, cache hits |
| `fh_library_add(id)` | download and store one record — `pmid:`, `doi:` (paper), `dailymed:` (FDA drug label), `nct:` (trial record); a paper with its full text wherever it can be obtained |
| `fh_library_status(id)` | the status of one record (level, citable, corrections) |
| `fh_library_read(id, section?, query?, max_chars?, max_hits?)` | the outline, one section or the passages matching a query; adds a missing record first |
| `fh_verify_claim(claim, id)` | does this source state this claim? A verdict from the decider, on full text or abstract; adds a missing record first |
| `fh_pubmed_search_articles(query, max_results?, sort?, years?)` | search PubMed in its own syntax: PMID, title, first author, year, journal, publication types, PMCID, library level |
| `fh_pubmed_fetch_articles(pmids)` | title, first author, year, publication types, retracted and level for up to 200 PMIDs at once |
| `fh_clinicaltrials_search_studies(query \| intervention \| condition, status?, sort?, max_results?)` | search ClinicalTrials.gov: NCT ID, title, status, phase, enrollment, dates, primary outcome, conditions, interventions |
| `fh_clinicaltrials_get_study_record(nct)` | one trial as a review needs it: status, design, enrollment, dates, outcomes, eligibility, result publications |
| `fh_clinicaltrials_get_study_results(nct, max_chars?)` | a trial's posted results as Markdown, capped |
| `fh_dailymed_search_labels(drug_name, labeler?, max_results?)` | find FDA drug labels by name: set ID, title, manufacturer, published date, version |
| `fh_fetch_url(url, max_length?, start_index?, raw?, title_only?)` | a web page or PDF as Markdown (XML, JSON and other text as is), cached, through the download cascade; same answer as the standard fetch tool |


## Quick Start

- Add the MCP server

```json
{
  "mcpServers": {
    "evidence-mcp": {
      "command": "npx",
      "args": ["-y", "evidence-mcp@latest"]
    }
  }
}
```

A `.env` elsewhere than your project root: add `"--env", "/path/to/.env"` to `args`.

Works out of the box with the keyless sources (PubMed, PMC, Europe PMC, Unpaywall, OpenAlex, plain fetch); only claim verification needs a Perplexity, Google, OpenAI, or Liquid AI key, or a local Decider.

**Configuration** (optional)

- Clone this repository
- Put a copy of `<clone>/.env.example` as `.env` in your project root, or tell your agent to add its content to your existing `.env`

**Decider Model** (optional, for claim verification)

- Choose the provider with `FH_VERIFY_PROVIDER` (`perplexity`, `google`, `openai`, or `liquid`); which one to take: [Decision models compared](docs/deciders.md)
- Perplexity: set your [Perplexity API key](https://docs.perplexity.ai) or set up a local [Perplexity Decider for Mac](https://docs.perplexity.ai/docs/decisions/decider-for-mac)
- Google: set your [Google AI Studio API key](https://aistudio.google.com/apikey); the free tier allows 50,000 input tokens per minute (one or two full-text papers), and on it Google may use what is sent to improve its products (the paid tier does not)
- OpenAI: set your [OpenAI API key](https://platform.openai.com/api-keys)
- Liquid AI: set your [Liquid API key](https://console.liquid.ai); the default model is `d1-ultra`

**Download Cascade** (optional)

- Configure the desired download services (fetch proxy, Playwright servers, Chrome, unlockers)
- Tell your agent to run `<clone>/utilities/deploy.sh up` from your project folder (or with `--env <your .env>`) to deploy the configured cascade
- Tell your agent to test the cascade for functionality and to detect accessibility issues (firewall, etc.)


## Monitoring

- Run `<clone>/tui/run.sh` from the folder that holds your `.env` (requires Python 3)

## Demo Skill

`/ev` is a Claude Code skill that shows the server at work on any document that cites medical sources. It ships with this repository: clone the repository and open Claude Code in your clone.

The [samples](samples/) folder holds a demo document, [telmisartan.md](samples/telmisartan.md) (an evidence review of telmisartan), to try the commands on.

The server stores its library in the `evidence/` folder of the clone.

| Command | |
|---|---|
| `/ev` or `/ev help` | the commands |
| `/ev info` | server, configuration and library contents |
| `/ev ingest <file>` | every source the document cites (PubMed, DOI, trials, drug labels) added to the library → `<file>_sources.md` |
| `/ev verify <file>` | every claim the document makes, checked against the source it cites → `<file>_claims.md` |

The file name is enough: documents are looked up in `samples/`. With the sample:

```
/ev ingest telmisartan.md   → samples/telmisartan_sources.md
/ev verify telmisartan.md   → samples/telmisartan_claims.md
```

Put your own document in `samples/` and use its filename.

## Documentation

- Configuration: every setting is explained in [.env.example](.env.example)
- Download cascade, deployment, and troubleshooting: [utilities/README.md](utilities/README.md)

## License

MIT — © 2026 Forever Healthy Foundation
