# Decision models for claim verification

`fh_verify_claim` asks a decision model whether a source states a claim. Which model to use, from our tests (November 2026):

**Recommended: Perplexity's Decider** — hosted `pplx-decider-v1.2`, or the Decider for Mac app to keep papers local.

## Tests

**Test 1 — 22 test claims with a known answer**, including traps such as a planted wrong number.

**Test 2 — 269 claims spanning 66 sources** (papers, trial records, drug labels) **from an [evidence review on telmisartan](https://evipedia.ai/telmisartan.md)**, each checked against the source it cites; where the models disagree, the right answer was decided by reading the paper.

## Hosted models

Wrong verdicts: a claim the paper does not support that was **passed**, or a correct claim that was **failed**.

| Model | Test 1: wrong (of 22) | Test 2: wrongly passed (of 269) | Test 2: wrongly failed (of 269) | Time per check |
| --- | --- | --- | --- | --- |
| Perplexity `pplx-decider-v1.2` | 0 | 2 | 1 | 0.7 s |
| Liquid `d1-ultra` | 0 | 2 | 7 | 1.8 s |
| OpenAI `gpt-6-luna` | 0 | 2 | 9 | 0.5 s |
| Google `gemini-decision-1` | 0 | 0 | 14 | 0.5 s |

Notes on test 2:

- **Perplexity** passed two claims that say more than the paper: "no interaction with warfarin" where the study found no *clinically relevant* one, and heart failure and renal artery stenosis as risks for low blood pressure, which the drug label does not state. It failed one borderline claim the paper supports.
- **Liquid `d1-ultra`** passed the same two, and failed seven correct claims the paper makes in other words, such as "small gains in fasting glucose" for a significant reduction.
- **OpenAI `gpt-6-luna`** passed the same two, and failed nine correct claims with near-zero scores, some stated word for word — a blood-pressure result with its confidence interval scored 0.00.
- **Google `gemini-decision-1`** caught both over-claims, and was the only one to; but it failed fourteen correct claims, exact figures among them.

## Local models

To keep papers on your own machine:

- **Perplexity Decider for Mac** (`pplx-decider-flash-v1.2`): usable. It caught the planted wrong numbers we tried, with somewhat less margin than the hosted model. 0.2 s for an abstract, 2–3 s for a full paper, 20–25 s for a very long one.
- **Liquid `d1-2B`** (open weights, llama.cpp, 4-bit and 8-bit): not usable. In test 1 it passed a planted wrong number (72.9% where the paper says 62.9%) in every run.

Results and questions: [Discussion #2](https://github.com/forever-healthy/evidence-mcp/discussions/2).
