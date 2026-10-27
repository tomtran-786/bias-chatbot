# The protocol documents

`protocol_v3.md` is the instrument. Everything the assistant does — what it asks,
what it withholds, how it argues the verdict — is in there, so changing it
changes the intervention itself.

## Files

| File | What it is |
|---|---|
| `protocol_v3.md` | The used-item pricing protocol, on loss aversion (Novemsky & Kahneman 2005). The market is looked up and shown before the person names a price. |
| `protocol_v2.md` | The previous version: the person names a price first, as an uncoached baseline, and then sees the market. Kept so those runs can be reproduced; not loaded by default. |

`protocol_v1.md` (sunk cost, a five-dimension decision grader) and `_template.md`
were removed when the product became a resale price assistant. They are still in
git history if the earlier design is ever wanted again.

## What is in the file

Only the span between `<!-- GEM CORE START -->` and `<!-- GEM CORE END -->` is
the instrument. It holds:

- the role: a pricing assistant for someone about to sell a used item,
- the bias and its definition in observable terms, and the anchor study with the
  corrected framing ("price it as a buyer who does not own it"),
- the four things to find out — model, what they paid and when, how long they
  have used it, condition against the photos,
- the phases, written as prose a Gem can follow,
- the guardrails, chiefly **no price of any kind that the assistant was not given**.

Everything after it is the *harness notes*: the four things the app does that a
Gem cannot. They are scaffolding for this repo and are not sent to the model.

## Versioning

**Never edit a protocol that is in use.** Copy it to `protocol_v4.md`, change the
copy, and set `PROTOCOL_FILE=protocol_v4.md`. Two people running different
wordings of the same instrument and calling the result the same thing is how a
comparison quietly stops meaning anything.

The loader accepts only files named `protocol_vN.md` so the version is always
visible in the logs and in the system instruction.

## Things the code relies on

The app does not parse the protocol beyond cutting out the core, but several
things in the code assume what it says:

- **The four section headings of the verdict** — `Suggested price`, `Why this
  price`, `Where to sell`, `What would change this`. `lib/stages.ts` tells the
  model to use them; `components/Prose.tsx` renders `##` headings.
- **The 15% line.** The protocol says to name the bias when the locked price is
  15% or more above the market median; `OVERPRICED_AT` in `lib/pricing.ts` is
  what makes the app say `overpriced: true`. Change them together.
- **The four facts.** `FACT_COUNT` in `lib/stages.ts` is 4 because the protocol
  asks for four things, one per turn, the first already asked in the opening
  turn. Change the protocol's list and you change that number and the server's
  gate with it.
- **The two markers**, `[[STAGE:appraise]]` and `[[STAGE:complete]]`. They are
  appended by the app (`MARKER_RULE` in `lib/prompts.ts`) and are not part of the
  Gem core, because a Gem has nowhere to hide control text.

## The Gem

Only the core goes into the Gem builder. The app sends that same span as its
system instruction, plus the item, a short phase addendum and, on the verdict
turn, the computed market — which is what makes the two comparable rather than
merely similar.

A Gem has no way to enforce the harness notes, so running the same item through
both is a useful test: wherever the Gem names a price early, cites a link it
cannot have verified, or states a median of its own, is direct evidence for what
the app's structure buys.
