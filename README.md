# Decision grader

A decision assistant for the moment *before* a decision is made. Someone brings
a choice they have not yet settled, the assistant asks five questions about how
they are reasoning about it, **grades that pending decision** on a scorecard, and
then **recommends one of the options they listed** — with its confidence and with
what would change its mind.

Nothing here looks backwards. It is not a reflection tool, and "no advice" is not
one of its rules: producing a graded read and a recommendation is the job.

## The five phases

| Phase | Driven by | What happens |
|---|---|---|
| **Frame** | a form | The decision, the options, the deadline, the stakes. |
| **Probe** | the model | One question per turn, at least one per scored dimension. |
| **Commit** | a locked form | Their own pick and their own 1–5 rating, before they see anything. |
| **Grade** | the model | The scorecard: five dimensions, each scored and quoted. |
| **Recommend** | the model | One of *their* options, argued from the lowest scores. |

The commit step is the load-bearing one. A corrective framing only does anything
if the person has committed to a position first; if they can read the verdict
before forming their own view, the comparison is worthless. Here the grade is not
requested until the pick is locked, so there is nothing to read ahead to.

## Setup

```bash
npm install
cp .env.example .env.local   # then fill in GEMINI_API_KEY
```

Create a key at <https://aistudio.google.com/apikey>. No credit card, no
database, no other services.

```bash
npm run dev        # http://localhost:3000
npm test           # unit + route tests, no network
npm run typecheck
npm run build
```

## The protocol is the instrument

`protocols/` holds the assistant. Everything it asks, everything it scores and
how it recommends lives in a markdown document that is sent as the system
instruction on every turn — so editing it edits the intervention.

- `protocols/_template.md` — the bias-agnostic template, with `TODO(team)` slots.
  Deliberately unloadable: the loader only accepts `protocol_vN.md`.
- `protocols/protocol_v1.md` — a **placeholder** instantiation on sunk cost
  (Arkes & Blumer 1985), so the app runs before the lottery draft.
- `protocols/README.md` — how to instantiate it once the registry row is drawn.

The rubric lives inside the protocol, in a fenced ` ```rubric ` block, so the app
and the Gem read the same five dimensions rather than two copies that drift. Two
dimensions are fixed and bias-agnostic (**Live options**, **Checkable grounds**);
three are rewritten for the drawn bias from the anchor study's markers.

It is parsed and validated at startup — a rubric that is malformed, the wrong
length, or still carrying `TODO` takes the process down rather than producing an
authoritative-looking scorecard that grades nothing.

**Never edit a protocol that is in use.** Copy it to the next version and
repoint `PROTOCOL_FILE`.

## Exporting the Gem

Only the span between `<!-- GEM CORE START -->` and `<!-- GEM CORE END -->` goes
into the Gemini Gem builder. The app sends that same span as its system
instruction, plus a short phase addendum — which is what makes the two
comparable rather than merely similar.

Three things the app does that a Gem cannot, and they are the interesting part:

1. **The grade is data, not prose.** The grading turn is a single non-streaming
   call against a response schema. A Gem has no schema mechanism, so the Gem core
   asks for a markdown table instead.
2. **The headline score is computed, not asserted.** The app averages the five
   dimensions itself. A model asked for both the parts and the total will bend
   the total toward the verdict it has already formed; here it is only ever
   allowed to emit a per-dimension score it had to quote the person to justify.
3. **Phase order is enforced.** The API refuses to grade before every dimension
   has been asked about, refuses to grade before the pick is locked, and refuses
   to recommend before a grade exists. A Gem relies on the model remembering,
   which decays over a long conversation.

Running the same decision through both is worth doing: wherever the Gem drifts —
grading early, inflating its own total, skipping the commitment — is direct
evidence for what the gating buys.

### What "enforced" means

The server holds no state, so it derives the legal phase from the conversation it
is handed. That guards against **model drift**, which is the real failure mode.
It is not a security boundary: the person holding the conversation could post any
payload they liked, and they are the person being helped, so that is fine. Worth
being precise about rather than overclaiming.

## Study parameters

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_MODEL` | `gemini-3.6-flash` | Pinned deliberately — see below |
| `PROTOCOL_FILE` | `protocol_v1.md` | Which protocol to load |
| `MAX_TURNS` | `40` | Per-decision cap, guards the daily quota |

**Verify the model before each demo.** Google's catalog moves: at the time of
writing `gemini-2.5-flash` returns 404 for newly created keys, and the newest
model carries roughly 20 requests/day on the free tier, which one decision would
exhaust on its own. Real per-model quotas are published only at
<https://aistudio.google.com/rate-limit>, not in the API docs.

Quota exhaustion is handled rather than hidden: a banner says to wait and resend,
and any text generated before the failure stays on screen.

## Known limitations

- **A refresh loses an in-progress decision.** There is no database and no
  session; the browser holds the conversation and posts it with each turn. That
  is the deliberate trade for having no storage at all. `sessionStorage` would
  fix it without adding a server.
- **Nothing is recorded.** No transcripts, no scores, no analytics. If the team
  later wants data from pilot runs, that is a new decision, not an oversight.
- **The endpoint is open.** With no auth, anyone with the URL can post to it.
  Fine while it runs on localhost.
