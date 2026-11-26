---
name: ev
description: Demonstration skill for the Forever Healthy Evidence MCP (/ev). Commands - help (also with no command), info, ingest <file>, verify <file>; a file name is looked up in samples/.
---

# Forever Healthy Evidence MCP — demonstration (`/ev`)

Demonstrates what the MCP does, on any document that cites medical sources. Tools: the `evidence-mcp` server's `fh_*` tools (`mcp__evidence-mcp__*`, the npm package `evidence-mcp`, as configured in this repository's `.mcp.json`).


## General Rules

* Parse the user's input to determine which sub-command to execute
* Set [args] to $ARGUMENTS
* Note the [start_time] when beginning any command, and report the [time_taken] when done
* No [args], or `help`: run COMMAND: help
* [file] (ingest, verify): the file name after the command, looked up in the `samples/` folder of the current directory — `telmisartan.md` is `samples/telmisartan.md` (a name without extension gets `.md`). A path with a folder in it (`docs/review.md`) is taken as given. No file name: `samples/telmisartan.md`. Not found: report `not found: <file>` and the files in `samples/`, and stop


## COMMAND: help

`Print what /ev does, nothing else: no tool call.`

* Print exactly:

```
/ev — demonstrates the Forever Healthy Evidence MCP

  /ev info             server, configuration and library contents
  /ev ingest <file>    every source a document cites (PubMed, DOI, trials,
                       drug labels) added to the library → <file>_sources.md
  /ev verify <file>    every claim the document makes against a cited source,
                       checked against that source → <file>_claims.md
  /ev help             this text

The file name is enough: documents are looked up in samples/.
Try it: /ev ingest telmisartan.md
```


## COMMAND: info

`Show the server's configuration and the library's contents, without adding anything.`

* Call `fh_info`; no [args] are used
* Report, one line each:
  * `package` and `version`, `host`, `evidence_dir` and `log`
  * `config`: the optional keys NCBI, Wiley TDM, CORE, Bright Data, Elsevier, proxy split into `keys set: …` and `unset: …` by their `config.sources` entry (`.env` or `environment` is set, `default` is unset), never a value; then `retry_after_days`, `retry_blocked`, `refresh_after_days`, and `problems`
  * `tiers`: the names in run order, a disabled one marked `(off)`
  * `download`: `fetch`; `playwright.version`, then each of `playwright.servers` as `label endpoint headless`; each of `chrome` as `label endpoint` (or `chrome: none`); `unlocker`
  * `verify`: `model`, `base_url`, `ok` with `ms`, or `error`
  * `entries` and `size`; then per type in `types` (pmid, doi, dailymed, nct, url) the counts `entries / full_text / abstract / title / retracted`
  * `retracted`, `not_citable`, `errata`, `concerns`, `updates`
* Report: `time_taken: [time_taken]`


## COMMAND: ingest {file}

`Add every source a document names to the library, and list what the library holds for each.`

Works on any text document (Markdown, HTML, plain text). [file] as in General Rules; [sources_file] is [file] without its extension plus `_sources.md`, next to it (`samples/telmisartan.md` → `samples/telmisartan_sources.md`).

* Report: `ingest: [file]`

* Read [file] and list every source it names, each once, in order of first appearance, with an ID and a URL. Use whatever means you have (reading, search, a script you write); none ships with the skill:
  - a PubMed link or a plain `PMID: <n>` → `pmid:<n>`, URL `https://pubmed.ncbi.nlm.nih.gov/<n>/`
  - a doi.org link or a plain DOI (`doi:10.…`, `10.…/…`) → `doi:<DOI>` (trailing sentence punctuation is not part of it), URL `https://doi.org/<DOI>`
  - a DailyMed label link (`…?setid=<set ID>`) → `dailymed:<set ID>` (lowercase), the link as URL
  - a ClinicalTrials.gov record link or a plain `NCT<8 digits>` → `nct:<8 digits>`, URL `https://clinicaltrials.gov/study/NCT<8 digits>`
  - a link wins over a plain mention of the same source; one ID per source, however often it is cited
  - links to any other site are not library sources; text inside HTML comments is skipped
* No sources: report `no sources found in [file]` and stop

* For each source call `fh_library_add` with its ID, one call per source, in that order. Nothing of the source is read; fill its row from the returned status only:
  - `ID`: the ID as passed, as link text, linked to its URL (e.g. `[pmid:30955454](https://pubmed.ncbi.nlm.nih.gov/30955454/)`)
  - `Abstract`: 🟢 if `has_abstract` is true, 🔴 if false (a title-only record: letter, editorial, old paper); `N/A` for a drug label or a trial record, which has none
  - `Full Text`: 🟢 if `level` is `full_text`, 🔴 if `abstract` or `title`
  - `Citable`: 🟢 if `citable` is true, 🔴 if false (retracted, or nothing to read)
  - `Comment`: the status's `comment` verbatim when not null. Add `preprint` when `publication_types` contains `Preprint`; when `Full Text` is 🟢 and `version` is not `published`, the version in words, no year: `accepted manuscript`, `preprint`, or the value as it is (a label's `spl 52`); for a trial record `updated <version>` and, when `publications` is not empty, `results: ` with its IDs; for a `doi:` source `not in PubMed` when `pmid` is null, else `in PubMed as pmid:<PMID>`. Otherwise empty. A 🔴 in `Abstract` or `Full Text` needs no comment: paywalls are normal, and the sources tried are in the library's log
  - A status with an `error` (e.g. `pmid not found`): `ID` filled, `Abstract`, `Full Text` and `Citable` 🔴, the error in `Comment`

* Write [sources_file]:

```
# Sources: <file name>

* Document: [file]
* Ingested: <YYYY-MM-DD HH:MM> with <package> <version> (from `fh_info`)
* Sources: <rows> — <n> pmid, <n> doi, <n> dailymed, <n> nct

| ID | Abstract | Full Text | Citable | Comment |
| -- | -------- | --------- | ------- | ------- |
| [type:id](<url>) | 🟢 | 🔴 | 🟢 | |
```

* Report the counts from the written table: rows, and 🟢 / 🔴 / N/A per column (Abstract, Full Text, Citable), and rows with a comment; the header's counts must match them
* Report: `sources_file: [sources_file]`
* Report: `time_taken: [time_taken]`


## COMMAND: verify {file}

`Check every claim the document makes against the source it cites for it.`

Works on any text document. [file] as in General Rules; [claims_file] is [file] without its extension plus `_claims.md`, next to it (`samples/telmisartan.md` → `samples/telmisartan_claims.md`).

* Report: `verify: [file]`

* Call `fh_info`; [model] is its `verify.model`. When its `verify` is null, no decision model is configured: report `No decision model configured — set FH_VERIFY_PROVIDER and its API key in .env (README → Decider Model).` and stop; write no table. When `verify.ok` is false, report `Decision model not reachable: <verify.error>` and stop.

* Read [file]. Skip front matter, the reference list and text inside HTML comments.

* Extract the claims. A claim is a statement of fact the document backs with a citation: a link or mention of a library source (PubMed, DOI, DailyMed, ClinicalTrials.gov — the same sources and IDs as `/ev ingest`). For each cited sentence:
  - **One finding per row.** A sentence with two findings (two outcomes, two numbers about different things) becomes two rows.
  - **The document's own words.** Keep the subject, the intervention, the outcome and every number with its unit and confidence interval as written. Do not paraphrase, round or add.
  - **A complete statement.** Replace a pronoun or "it" with what it stands for, from the sentence before if needed, so the claim stands alone (at least four words, starting with the subject).
  - **Citation and framing cut.** Drop the link or reference marker, and the document's framing ("A 2019 meta-analysis found that", "Notably,", "In our view") — keep only what the source reports.
  - **One row per source.** A finding cited to several sources becomes one row per source, each with the same claim.
  - **Not a claim:** a heading, a sentence without a citation, a recommendation or the document's own conclusion, a sentence citing a web page that is not a library source.
  - [line] is the line number of the sentence in [file].

* For each row call `fh_verify_claim` with the claim and the source ID, one call per row, in document order. Fill the row from the answer only:
  - `verdict` `supported` → 🟢; `not_supported` → 🔴; `unverifiable` → 🟡
  - `error` (the claim was refused: too short, a fragment, carrying a citation): correct the claim as the error says and call once more with the corrected claim, which goes in the row. Still an `error`, or an error that is not about the claim (source not found, no decision model): 🟡 with the error in `Comment`
  - `Comment`: `abstract only` when `basis` is `abstract` and the verdict is 🟢; the `reason` when not null; `superseded by a correction` when `superseded` is true; `glyphs: <n>` when `glyphs_unresolved` is above 0 and the verdict is 🔴. Otherwise empty

* Write [claims_file]:

```
# Claims: <file name>

* Document: [file]
* Verified: <YYYY-MM-DD HH:MM> by <model> via <package> <version> (from `fh_info`)
* Claims: <rows> against <n> sources

| Line | Claim | ID | Result | Comment |
| ---- | ----- | -- | ------ | ------- |
| 42 | Telmisartan lowered systolic blood pressure by 12 mmHg | [pmid:30955454](https://pubmed.ncbi.nlm.nih.gov/30955454/) | 🟢 | |
```

  The `ID` cell is linked like in `/ev ingest`. A `|` inside a claim is written `\|`.

* Report the counts from the written table: claims and distinct sources, 🟢 / 🔴 / 🟡, and rows with a comment; the header's counts must match them
* Report: `claims_file: [claims_file]`
* Report: `time_taken: [time_taken]`
