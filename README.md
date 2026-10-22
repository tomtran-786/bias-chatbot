# Resale price assistant

A pricing assistant for the moment *before* something is listed for sale. Someone
brings a used item. The assistant asks about it from photos and four short
questions, has them **commit to the price they would list it at before they see
anything about the market**, then finds used listings of the same model, works
out the market price, and gives a suggested price, the reasons, and where to
sell — set against the price they committed to.

It is built on **loss aversion** (Novemsky & Kahneman 2005): people who own an
item value it at roughly 1.85 times what people who do not own it will pay, so a
seller's first number is usually too high. The locked price is that
measurement; the market median is the corrective.

The interface is English and the money is US dollars. Listings come from
international marketplaces (eBay, Facebook Marketplace, Swappa, Mercari and
similar).

## The six phases

| Phase | Driven by | What happens |
|---|---|---|
| **Intake** | a form | One to four photos and a line: "What are you selling?" |
| **Questions** | the model | One question per turn covering four things: the exact model, what they paid and when, how long they have used it, and its condition checked against the photos. May ask for more photos. |
| **Your price** | a locked form | "Before you see the market: what price would you list it at?" in USD. |
| **The market** | the app + the model | Search, check each listing against its source, compute the median, range, per-platform split, suggested price and gap. Shown as a card. |
| **Verdict** | the model | Four sections: Suggested price · Why this price · Where to sell · What would change this. The bias is named only when the app marks the price `overpriced`. |
| **Finished** | — | |

The price step is the load-bearing one. A corrective only does anything if the
person has committed to a number first; if they can read the market before
forming their own view, the comparison is worthless. Here the market is not
looked up until the price is locked, and the model that reads the listings is
never told that price — or what they paid.

## Setup

```bash
npm install
cp .env.example .env.local   # then fill in GEMINI_API_KEY
```

Create a key at <https://aistudio.google.com/apikey>. There is no database and
no other service.

```bash
npm run dev        # http://localhost:3000
npm test           # unit + route tests, no network, no quota
npm run typecheck
npm run lint
npm run build
npm run spike      # real API: does Search grounding behave as this code assumes?
```

### The market search needs a key with Search grounding quota

The conversation, the facts and the verdict are ordinary model calls. The market
lookup uses **Grounding with Google Search**, which is a separate tool with its
own quota — and on a free-tier key it is often zero even when ordinary calls work
fine. When it is, the lookup fails with a 429 and the app shows a banner saying
so.

`npm run spike` makes this plain: it first checks that a call without the tool
works and one with it does not, and says which. Check what your key has at
<https://aistudio.google.com/rate-limit>; if Search grounding is not included,
use a key from a project with billing enabled.

## How the market is worked out

Everything the person is shown comes from `lib/pricing.ts`, from listings the
model *reported*. The model never states a number that is displayed.

1. **Facts.** One call with no tools reads the conversation and photos and
   returns the item as data. If it cannot name the model, the app goes back to
   the questions rather than search for a guess (`needs_identity`).
2. **Search.** A call with Google Search, given the item but *not* what they paid
   or what they locked in. Dollar amounts are scrubbed out of the free-text
   fields as well.
3. **Extraction.** A second call, no tools, turns the search summary into
   listings. Each listing points at one of the sources the search retrieved
   (`sourceIndex`) — it does not carry a URL.
4. **Grounding** (`lib/grounding.ts`). Google's redirect links are followed to
   their real address (the `Location` header only; the destination is never
   fetched). The link a person sees is always one of those, never a URL the model
   wrote. A listing whose source is an item page counts; one whose source is only
   the right site is shown dimmed and left out of the median.
5. **Pricing** (`lib/pricing.ts`).
   - Prices are parsed from the text as shown ("US $1,049.99"); other currencies,
     ranges and unparseable prices are dropped.
   - For-parts listings, listings above the new price, duplicates, and listings
     outside 0.33×–3× the first-pass median are dropped. At most 3 per site, 10 in
     all.
   - Sold listings are used on their own once there are five; otherwise asking
     prices are used and the card says asking prices run high.
   - **Five or more** listings: median, middle-half range, and a condition
     adjustment — the model picks `below | typical | above` with its evidence,
     and the app maps that to P25 / median / P75, capped at P75 and at 0.9× the
     new price, rounded to a price people list at. **Three or four:** median only,
     flagged as thin. **Fewer than three:** no price, no gap; the verdict explains
     how to price it themselves.
   - The price is `overpriced` when it is 15% or more above the median.

The server recomputes all of this on the verdict turn from the raw listings the
browser posts back; it does not believe a median the client sends.

## Photos

Every photo is re-encoded in the browser — 1024px on the long edge, JPEG — before
it is sent. That keeps each under 400 KB, because a stateless conversation
re-posts them on every turn, and it removes EXIF data including location. Formats
the browser cannot decode (HEIC) are reported rather than dropped silently.
Photos go to the model only where they first appear and only during the
questions; the verdict argues from the facts already extracted.

## The protocol is the instrument

`protocols/protocol_v2.md` holds the assistant. Everything it asks, withholds and
recommends lives in a markdown document sent as the system instruction on every
turn, so editing it edits the intervention. See `protocols/README.md`.

**Never edit a protocol that is in use.** Copy it to the next version and repoint
`PROTOCOL_FILE`.

Only the span between `<!-- GEM CORE START -->` and `<!-- GEM CORE END -->` goes
into the Gemini Gem builder. Four things the app does that a Gem cannot:

1. **The search cannot see their price.** It is a separate call given the item
   and never the numbers.
2. **Sources are verified, not trusted.** Links come from the search's own
   metadata, and a listing is only counted if its source is an item page.
3. **The market price is computed.** The model reports listings and a position;
   the app does the arithmetic.
4. **Phase order is enforced.** No price before four questions and a photo, no
   lookup before the price is locked, no verdict before there is a market.

### What "enforced" means

The server holds no state, so it derives the legal phase from the conversation it
is handed. That guards against **model drift**, which is the real failure mode.
It is not a security boundary: the person holding the conversation could post any
payload they liked, and they are the person being helped, so that is fine. Worth
being precise about rather than overclaiming.

## Parameters

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_MODEL` | `gemini-3.6-flash` | Pinned deliberately — see below |
| `PROTOCOL_FILE` | `protocol_v2.md` | Which protocol to load |
| `MAX_TURNS` | `20` | Per-conversation cap, guards the quota |

**Verify the model before each demo.** Google's catalog moves: at the time of
writing `gemini-2.5-flash` returns 404 for newly created keys. Real per-model
quotas are published only at <https://aistudio.google.com/rate-limit>, not in the
API docs. A full appraisal is roughly ten model calls, one of them using Search
grounding, so budget accordingly.

Quota exhaustion is handled rather than hidden: a banner says to wait, and any
text generated before the failure stays on screen.

## Known limitations

- **Listings are not sold prices.** Unless a listing is marked sold, it is what a
  seller is *asking*, which runs high. The card says which it used. A search also
  misses listings and sometimes picks up the wrong variant.
- **Sources can be few.** A rare item may return too few listings to state a
  price; the app says so rather than guess.
- **The item-page rule is a heuristic.** `lib/grounding.ts` decides what counts as
  an item page from how each marketplace structures its URLs. It was written from
  those structures, not tuned on captured search results; run `npm run spike` and
  check it against real sources before relying on the "counted" level.
- **The sample response in `tests/fixtures/grounding-sample.json` is synthetic**,
  written to the SDK's types because Search had no quota when it was made. Replace
  it with output from `npm run spike`.
- **A refresh loses an in-progress appraisal.** There is no database and no
  session; the browser holds the conversation and posts it with each turn.
  `sessionStorage` would fix it without adding a server.
- **Nothing is recorded.** No transcripts, no prices, no analytics. If the team
  later wants data from pilot runs, that is a new decision, not an oversight.
- **The endpoint is open.** With no auth, anyone with the URL can post to it and
  spend the quota. Fine while it runs on localhost.
