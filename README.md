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
npm run spike      # real APIs: Tavily + Gemini on three items (spends ~9 Tavily credits)
```

### Two free keys, and what keeps this free

The app needs a Gemini key and a Tavily key, both on free plans with no card:

- **Gemini** from <https://aistudio.google.com/apikey>. In AI Studio, check the
  key's project is on the **Free** tier with no billing account attached.
- **Tavily** from <https://tavily.com>: 1,000 credits a month on the free plan. One
  appraisal is two searches, so about 500 appraisals a month. **Leave pay-as-you-go
  off.** Out of credits is then an error (HTTP 432), not a charge.

Those two account settings are what make the app free; nothing in the code can. The
daily budget (`DAILY_SEARCH_BUDGET`, `DAILY_MODEL_BUDGET`) is a tripwire against a
loop, held in memory and reset on restart, so it is a second line of defence only.

The model is never given a tool. An earlier version used Gemini's built-in Google
Search grounding, but that tool is not available on Gemini's free tier — it needs
billing — which broke the "never ask for a card" rule. So the app now does the
searching itself and the model only reads what it finds.

`npm run spike` runs the real pipeline for three items (a phone, headphones and a
rare one) and prints what each stage found. It spends about 9 Tavily credits.
`npm run spike -- --save` also records `tests/fixtures/tavily-sample.json`.

### When Gemini runs out: other Gemini models first

Gemini's free quota is counted **per model**, and on the same key several models
usually still have some when one is spent. So every call goes down a chain: the model
in `GEMINI_MODEL`, then each name in `GEMINI_FALLBACK_MODELS`, moving on when one says
quota (429), overloaded (503) or not available to the key (404). The chain is
free, needs no new account, and the models can see photos, so nothing about the
conversation changes. When one is refused, the next call tries it last for a minute
(ten for a 404) instead of opening with the same refusal again.

- **What does not move on:** a timeout (it has already used its 45 seconds, and a second
  attempt would not fit in the request), a bad request, or an answer that was received but
  is wrong (swapping models would hide a prompt problem). A reply that has already started
  is never continued by a different model.
- **If every model refuses**, the error says which were tried (`Tried a, b, c.`) and a quota
  error outranks an overload, since it is the one to act on.
- **Configure it** in `.env.local`; unset means a default list, set-but-empty means no
  chain. Names that do not exist for the key are skipped with a warning in the server log,
  so a stale entry costs one refused call, not an outage. Model names move — `gemini-2.5-*`
  already 404s for new keys and some models answer 429 (no free quota) or hang under load —
  so check what answers on your key before relying on the list.
- **Quality varies.** A `flash-lite` model reads search results and extracts facts a little
  less carefully than a full flash model; the verbatim price check applies to every one.

### Then a free backup: OpenRouter (optional)

If every Gemini model has refused, the app can finish the request with a **free**
OpenRouter model. It is off unless `OPENROUTER_API_KEY` is set.

- **It cannot cost money, and the code enforces it.** OpenRouter bills per token for every
  model except those whose id ends in `:free` (and its `openrouter/free` router, which only
  picks among them). Before any request is built, `lib/openrouter.ts` drops every configured
  model that is not free, with a warning in the server log; if none is left, OpenRouter
  reports itself as not configured and no call is made. So a key that has credits on it
  cannot be charged by a paid model named in `OPENROUTER_MODELS` by mistake.
- **It is capped.** Free models allow 20 requests a minute, and 50 a day on an account that
  has bought fewer than 10 credits (1,000 a day above that). An appraisal is about nine
  model calls, so the low cap is roughly five appraisals a day, and only once Gemini has
  run out.
- **Free models are flaky, so there are four.** `OPENROUTER_MODELS` is tried in order, and
  one that is rate limited, busy, or removed is skipped for the next (a model that just
  refused is tried last for a minute). On the first live run roughly half of all calls were
  refused by the upstream provider: a shared free pool that was busy (429), a 502, one
  provider answering 404 for the account. The default is four named models from four
  providers that returned valid JSON; a refused attempt is not counted against the daily
  cap, only an answer is. `openrouter/free` is allowed but not default: it routes to
  whatever is free at that moment, and once chose a safety classifier that answered
  "User Safety: safe". Check <https://openrouter.ai/models?max_price=0> if they stop answering.
- **Reasoning is switched off.** Several free models reason before they answer, spending
  the whole token budget before writing a word (a minute of nothing, then an empty reply).
  Every request sends `reasoning: {effort: "none"}`; a model that cannot disable it answers
  400 with the reason.
- **Quality is below Gemini's.** On the same real search results, one free model found two
  listings and another found none where Gemini found three. The verbatim price check means
  a weak reading shows up as fewer verified listings (a thin or empty market), never as a
  wrong price.
- **Text only.** No photo is sent, so photos still go to Google alone, and the model is
  told it cannot see them. The conversation text goes to OpenRouter and the provider that
  serves the model. OpenRouter's own prompt logging and use of inputs are off unless you
  turn them on; its docs do not say what each free provider does with prompts, and some
  free models may not be served unless your privacy settings allow it.
- **It answers JSON loosely.** Free models often wrap the object in a code fence or a
  sentence, so the reader strips that; the same schema checks and the same verbatim price
  check apply as for every other model.

### Last resort: DeepSeek (optional, not free)

Only when **every** Gemini model has refused **and** OpenRouter (if set up) has failed
too, the app can finish the request with DeepSeek instead. It is off unless
`DEEPSEEK_API_KEY` is set; with no key a Gemini quota error is just reported, and the app
stays free.

- **It is not free.** DeepSeek is prepaid: model costs come off a topped-up balance (or
  a granted one, which its docs do not promise), and at zero the API answers 402. So it
  cannot bill past what is on the account, but it does need money on the account, which
  is why it is an opt-in extra and not part of the free setup above. Prices are in CNY;
  `deepseek-flash` was about 1–2 per million input tokens and 4–8 per million output
  tokens when this was written, so an appraisal is a fraction of a cent.
- **Text only.** No photo is ever sent to DeepSeek, so photos still go to Google alone.
  The model is told in plain words that it cannot see them, and asked to have the person
  describe wear in words. Its documentation lists image input for `deepseek-flash`, but
  the request format is not in the API reference, so this does not guess one.
- **The same instrument.** Protocol, phase instruction, schemas and parsing are shared
  (`lib/prompts.ts`); the backup differs only in transport. Its JSON mode cannot enforce
  a schema, so the schema is in the prompt and the same zod checks and the same verbatim
  price check apply to its answers.
- **What triggers a backup.** Only when the whole Gemini chain has refused for quota or overload, and for a reply only if
  Gemini failed before saying anything: half of one reply from each model would be worse
  than an error. Timeouts and malformed answers do not trigger it.
- **It is not shown on screen.** The screen never names a model or says a backup
  answered, and failures read as plain "try again" copy. The `notice` stream event and
  the `backup` field of the market response (which step a backup took: `facts` is read
  from the messages alone, since it cannot see photos; `reading` is the search results)
  are still sent, for whoever is debugging, and the server's `reason` for a failed
  lookup goes to the browser console rather than the page.
- **Privacy.** Using it sends the conversation text, including what the person wrote
  about the item, to a backup provider's servers. The intake screen says so in general
  terms ("third-party AI services, which may use them to improve their products")
  without naming which.
- **If it fails too**, the error names both (Gemini's is the one classified) and says
  what happened to the backup.

`lib/model.ts` is the only place that decides this; the routes never call a model
directly. **It has not yet been run against the real DeepSeek API**: it is written to
the documentation and covered by tests that replace the network, so the first real
call may need adjusting.

### Privacy

On the free Gemini tier, what is sent to Gemini — the conversation and the photos —
**may be used by Google to improve its products.** The intake screen says so, in
general terms and without naming the providers. The
app itself stores nothing. Photos are re-encoded in the browser, which strips their
location data, but faces, addresses and documents in the frame still go through.
The search service sees only the queries (an item name, never a price).

## How the market is worked out

Everything the person is shown comes from `lib/pricing.ts`, from listings the
model *reported*. The model never states a number that is displayed. The app
searches and the model reads: no model call has a `tools` entry, and a test checks
every request for it.

```
gate -> budget -> facts -> queries -> Tavily (<= 2) -> sources -> read -> ground -> price
```

1. **Budget** (`lib/budget.ts`). Two searches and two model calls are reserved up
   front, all or nothing; over the daily limit the request is refused (429
   `budget_exhausted`) before any API is called.
2. **Facts.** One model call with no tools reads the conversation and photos and
   returns the item as data. If it cannot name the model, the app goes back to the
   questions rather than search for a guess (`needs_identity`).
3. **Queries** (`searchQueries` in `lib/item.ts`). Built by code, not by the model:
   `"<item> used sold price"` and `"<item> used for sale"`. They are made from facts
   that have had every dollar amount scrubbed, so they cannot contain what the person
   paid or the price they locked in.
4. **Search** (`lib/search.ts`). Tavily, `search_depth: "basic"` (1 credit), ten
   results, restricted to used-item sites (eBay, Swappa, Mercari, OfferUp, Craigslist,
   Reverb, Poshmark, Depop, Back Market, Gazelle; not Facebook, which needs a login),
   with each page's body as markdown. A 15-second timeout, and **no retries**: a failed
   call is reported once. Tavily's errors map to 401 → `search_unavailable`, 432/433 →
   `search_quota`, 429 → `rate_limited`.
5. **Sources** (`lib/sources.ts`). Results are numbered `[0]..[n]`. A source's text is
   the search's own summary plus every line of the page with a `$` amount, cut to about
   3,000 characters.
6. **Read.** One model call with a response schema and no tools turns the numbered
   sources into listings, each carrying a `sourceIndex`, never a URL. It also reports the
   price of the item new, if a source states one, as `{ priceText, sourceIndex }`.
7. **Ground.** A listing counts only if its `priceText` appears **word for word** in
   the text of the source it cites (whitespace collapsed; `$1,049` does not match
   `US $1,049.99`). Otherwise it is shown dimmed and left out. The link shown is always
   the address Tavily returned, never one the model wrote. Because the price is checked
   against the text, list pages and price-guide pages count when their price matches.
   The **new price** is held to the same standard (`groundNewPrice`): the source must
   exist, the price must appear word for word in its text, and it must be one USD
   amount. A new price that fails is not used as a ceiling, and one that passes is
   linked to the page it came from.
8. **Price** (`lib/pricing.ts`).
   - Prices are parsed from the text as shown ("US $1,049.99"); other currencies,
     ranges and unparseable prices are dropped.
   - For-parts listings, listings above the new price, duplicates, and listings
     outside 0.33×–3× the first-pass median are dropped. At most 3 per source page, 10
     in all.
   - Sold listings are used on their own once there are five; otherwise asking
     prices are used and the card says asking prices run high.
   - **Five or more** listings: median, middle-half range, and a condition
     adjustment — the model picks `below | typical | above` with its evidence, and the
     app maps that to P25 / median / P75, capped at P75 and at 0.9× the new price,
     rounded to a price people list at. **Three or four:** median only, flagged as thin.
     **Fewer than three:** no price, no gap; the verdict explains how to price it
     themselves.
   - The price is `overpriced` when it is 15% or more above the median.

The server recomputes all of this on the verdict turn from the raw listings the
browser posts back; it does not believe a median the client sends.

### What the person sees

The market card tells one story, top to bottom: the title is the takeaway ("Your $520
is 24% above the market median", from `marketHeadline`), then the two figures it
compares, a strip of dots showing where their price sits among the listings (no
gridlines, no legend, the two lines that matter labelled directly), the suggested
price, and the sources it stands on. Every price that came from the web is a
numbered, clickable source: the same `[n]` (`lib/citations.ts`) marks the dot, the
row in the sources list grouped by platform, and the chip in the "Sources" line the
app draws under the verdict. The model does not write that line, so the protocol is
untouched. Prices that could not be confirmed on their page sit in a collapsed
section, numbered after the counted ones. How the search was run is behind "How this
was worked out", and the card names no vendor or model.

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

1. **The search cannot see their price.** The queries are built by code from facts
   with every dollar amount scrubbed out, and the model that reads the results is
   given the item and never the numbers. A Gem searches inside the same conversation
   where both are on the page.
2. **Sources are verified, not trusted.** A listing is counted only if its price
   appears word for word in the text of the page it cites, and the link shown is the
   address the search returned, never a URL the model wrote. A Gem will cite whatever
   URL it likes and report whatever price it likes.
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

One drift is also caught on the way out. The protocol the model holds contains the
verdict format, so a price typed into the chat while the phase is still the
questions (the price box only appears once the model emits the commit marker, and
the weaker fallback models sometimes do not) was answered with a full verdict that
no market stood behind. Outside the verdict phase, `app/api/chat/route.ts` holds the
first few words of each reply, and one that opens like a verdict (`opensLikeVerdict`)
or begins with the system prompt (`opensLikePrompt`, which the weaker models also
did when handed a price in the chat) is replaced by a line the app writes; once the
questions are done that line sends the person to the price box. It only catches a
reply that *starts* that way, and it is a net under the stage instruction rather
than a substitute for it.

## Parameters

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_MODEL` | `gemini-3.6-flash` | Pinned deliberately — see below |
| `PROTOCOL_FILE` | `protocol_v2.md` | Which protocol to load |
| `MAX_TURNS` | `20` | Per-conversation cap, guards the quota |
| `TAVILY_API_KEY` | — | Required to look up the market; read only when an appraisal runs |
| `GEMINI_FALLBACK_MODELS` | `gemini-3.5-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite` | Gemini models tried, in order, after `GEMINI_MODEL`; empty means none |
| `OPENROUTER_API_KEY` | — | Optional free backup; blank means none. Only `:free` models are ever called |
| `OPENROUTER_MODELS` | four named free models, from four providers (see `lib/env.ts`) | Free models tried in order; anything not free is dropped |
| `DEEPSEEK_API_KEY` | — | Optional backup model; blank means none. Prepaid, not free |
| `DEEPSEEK_MODEL` | `deepseek-flash` | Which DeepSeek model the backup uses |
| `DAILY_SEARCH_BUDGET` | `40` | Tavily calls per UTC day, counted in memory |
| `DAILY_MODEL_BUDGET` | `300` | Gemini calls per UTC day, counted in memory |

**Verify the model before each demo.** Google's catalog moves: at the time of
writing `gemini-2.5-flash` returns 404 for newly created keys, and a busy model can
answer 503 for a while. Real per-model quotas are published only at
<https://aistudio.google.com/rate-limit>. A full appraisal is roughly nine model calls
(five conversation turns, the facts, the reading, the verdict) and two Tavily credits.

Quota exhaustion is handled rather than hidden: a banner says what ran out and what
to do, and any text generated before a failure stays on screen. Nothing is retried
automatically.

## Known limitations

- **Popular items return few individual listings.** For the iPhone 13 the first real
  run found 12 sources but only 3 individual listings (a "thin" market): most of what
  Tavily returned for it was price-guide pages and category pages, whose figures are
  averages and ranges, which the reading deliberately does not count as listings. A
  headphone model and a rare item each gave 11. Counting a guide's "average sale
  price" as a data point would give more numbers and a weaker claim; that is a product
  decision, not a bug.
- **Refurbishers price high.** Gazelle and Back Market are in the search because they
  publish many prices, but they sell certified refurbished stock with a warranty, so
  their prices sit above what one person gets selling privately.
- **Listings are not sold prices.** Unless a listing is marked sold, it is what a
  seller is *asking*, which runs high. The card says which it used. A search also
  misses listings and sometimes picks up the wrong variant or an accessory (the
  outlier rule catches most of those).
- **The verbatim check proves the price is in the page text, not that it belongs to
  that listing.** A page that lists several items can carry the same amount for a
  different one. It rules out invented, rounded and misread prices, not every mix-up.
- **The backup cannot see photos**, so when it answers the condition is judged from
  what the person writes, which is a weaker check than the photos.
- **Free tiers move.** Gemini's free quota and Tavily's 1,000 credits can change, and
  a busy Gemini model can answer 503. Check both dashboards before a demo.
- **A refresh loses an in-progress appraisal.** There is no database and no
  session; the browser holds the conversation and posts it with each turn.
  `sessionStorage` would fix it without adding a server.
- **Nothing is recorded by this app.** No transcripts, no prices, no analytics. (Google
  and Tavily see what is sent to them; see Privacy.)
- **The server cannot stop a second appraisal.** It is stateless, so only the client
  limits a conversation to one; the daily budget is what bounds a client that ignores
  that.
- **The endpoint is open.** With no auth, anyone with the URL can post to it and spend
  the quota. Fine while it runs on localhost; the daily budget limits the damage.
