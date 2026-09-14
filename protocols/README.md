# The protocol documents

`_template.md` is the instrument. Everything the assistant does — what it asks,
what it scores, how it recommends — is in there, so changing it changes the
intervention itself.

## Files

| File | What it is |
|---|---|
| `_template.md` | The bias-agnostic template. Not loadable: the loader only accepts `protocol_vN.md`, so it can never be run by accident. |
| `protocol_v1.md` | A **placeholder** instantiation on sunk cost (Arkes & Blumer 1985), so the app runs before the lottery draft. |

## Instantiating it after the draft

1. `cp _template.md protocol_v2.md`
2. Fill in every `TODO(team)`:
   - the target bias and its operational definition,
   - the anchor study and the corrected framing it works from — written as a
     framing that can be applied to someone's situation, not as a citation,
   - the three bias-specific rubric dimensions in the ` ```rubric ` block, with
     their low and high anchors. **Leave `options` and `evidence` alone** —
     those two are fixed and bias-agnostic by design.
   - the five probe questions, at least one covering each dimension.
3. Set `PROTOCOL_FILE=protocol_v2.md` in `.env.local`.
4. Run `npm test` — the rubric block is parsed and validated at load, so a
   malformed or under-filled block fails loudly rather than producing a
   half-graded scorecard.

Leave `protocol_v1.md` in place as a worked example.

## The rubric block

The fenced ` ```rubric ` block is the single source of truth for the scorecard.
The app parses it to build the response schema and to render the results; the
Gem reads the same block as instructions. There must be exactly five entries
with unique ids, and every field must be non-empty and free of `TODO`.

## Versioning

**Never edit a protocol that is in use.** Copy it to the next version number and
repoint `PROTOCOL_FILE`. Two people running different wordings of the same
instrument and calling the result the same thing is how a comparison quietly
stops meaning anything.

## The Gem

Only the span between `<!-- GEM CORE START -->` and `<!-- GEM CORE END -->` goes
into the Gem builder. Everything outside it is scaffolding for this repo. The app
runs that same span as its system instruction, plus a short phase addendum, which
is what makes the two comparable.
