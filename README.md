# Resale price assistant

A pricing assistant for the moment *before* something is listed for sale. Someone
brings a used item. The assistant asks about it from photos and a few short
questions, finds used listings of the same model and works out the market price,
shows them that, then has them **commit to the price they would list it at**, and
gives a suggested price, the reasons, and where to sell — set against the price
they committed to.

It is built on **loss aversion** (Novemsky & Kahneman 2005): people who own an
item value it at roughly 1.85 times what people who do not own it will pay, so a
seller's first number is usually too high. The market median is the corrective,
and the locked price is what it is set against. The price is set with the market
in view, so it is not an uncoached baseline (see `protocols/protocol_v3.md`).

The interface is English and the money is US dollars. Listings come from
international marketplaces (eBay, Facebook Marketplace, Swappa, Mercari and
similar).

## The six phases

| Phase | Driven by | What happens |
|---|---|---|
| **Intake** | a form | One to four photos and a line: "What are you selling?" |
| **Questions** | the model | One question per turn covering four things: the exact model, what they paid and when, how long they have used it, and its condition checked against the photos. May ask for more photos. |
| **The market** | the app + the model | Search, check each listing against its source, compute the median, range, per-platform split and suggested price. Shown as a card, before any price is asked for. |
| **Your price** | a locked form | "Now it's your call: what price would you list it at?" in USD, once the market is on screen. Then a short card sets it against the market median. |
| **Verdict** | the model | Four sections: Suggested price · Why this price · Where to sell · What would change this. The bias is named only when the app marks the price `overpriced`. |
| **Finished** | — | |

The market is looked up and shown first, and the price is asked for after. That is
a change from the earlier design, which locked the price before the market was
looked up so that it was an uncoached baseline (`protocols/protocol_v2.md`, still in
the repo). Prices recorded now were set having seen the market and are not
comparable with those. What has not changed: the model that reads the listings is
never told what they paid, and there is no price for it to see, because the lookup
happens before one exists.

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
npm run spike      # real APIs: Tavily + Gemini on four items (spends ~16 Tavily credits)
```

### Two free keys, and what keeps this free

The app needs a Gemini key and a Tavily key, both on free plans with no card:

- **Gemini** from <https://aistudio.google.com/apikey>. In AI Studio, check the
  key's project is on the **Free** tier with no billing account attached.
- **Tavily** from <https://tavily.com>: 1,000 credits a month on the free plan. One
  lookup is three searches (two US, one Vietnamese), or four when the first round found
  little, so 250 to 330 lookups a month. A lookup that has to be redone after the person
  says more reuses its search if the item is the same. **Leave pay-as-you-go off.** Out
  of credits is then an error (HTTP 432), not a charge.

Those two account settings are what make the app free; nothing in the code can. The
daily budget (`DAILY_SEARCH_BUDGET`, `DAILY_MODEL_BUDGET`) is a tripwire against a
loop, held in memory and reset on restart, so it is a second line of defence only.

The model is never given a tool. An earlier version used Gemini's built-in Google
Search grounding, but that tool is not available on Gemini's free tier — it needs
billing — which broke the "never ask for a card" rule. So the app now does the
searching itself and the model only reads what it finds.

`npm run spike` runs the real pipeline for four items (a phone, headphones, a rare one
and the phone again on the Vietnamese marketplaces) and prints what each stage found. It
spends about 16 Tavily credits.
`npm run spike -- --save` also records `tests/fixtures/tavily-sample.json`.

### When Gemini runs out: other Gemini models first

Gemini's free quota is counted **per model**, and on the same key several models
usually still have some when one is spent. So every call goes down a chain: the model
in `GEMINI_MODEL`, then each name in `GEMINI_FALLBACK_MODELS`, moving on when one says
quota (429), overloaded (503) or not available to the key (404). The chain is
free, needs no new account, and the models can see photos, so nothing about the
conversation changes. When one is refused, the next call tries it last for a minute
(ten for a 404) instead of opening with the same refusal again.

- **A timeout, or an answer that is not the schema, moves on too.** A call gets 25 seconds
  and the whole chain about 50, inside the 60-second function each market step has to
  itself, so a model that hangs is given up on for the next. The model that timed out is
  tried last for a minute; one that merely answered badly is not remembered against, since
  that says nothing about its health. When every model answered badly, that is the error
  reported, so a prompt problem is not hidden.
- **What does not move on:** a bad request or a server fault, which are not about which
  model. A reply that has already started is never continued by a different model.
- **Thinking is kept low** (`thinkingLevel: LOW`) on every Gemini call. The 3.x models
  think for a long time by default, which was most of how slow a reply or a lookup felt.
  A model that answers 400 to the setting is asked again without it and not asked with it
  again; `npm run models` shows which models take it.
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
gate -> facts -> queries -> Tavily (3, then maybe 1) -> sources -> read -> ground -> price
```

**It runs in three requests, before the price is asked for.** `app/api/market/route.ts` takes a
`step`: `facts` (the conversation and photos in, the item out), `search` (the item in,
numbered sources out) and `read` (the item and sources in, grounded listings out). Each
step has a whole 60-second function, can be tried again without redoing the ones before
it, and the browser (`lib/market-client.ts`) runs them in order and retries each once if
the failure may pass (a server error, a timeout, a dropped connection), never after quota,
a spent budget, a rate limit or a refused key. The figures are then computed **in the
browser** with `computeAppraisal` from the listings the last step returned.

It starts as soon as the questions are done, and the market card is shown when it
finishes; the price box comes after. No step is shown a price or needs one. If a lookup
fails and the person tries again, or is sent back to the questions and adds something,
the facts are read again, and the search and the reading are reused when the item and
the facts the reading saw have not changed.

1. **Gate.** Every step needs the assistant to have spoken and a photo to exist, and
   nothing else. How many facts it has is the assistant's call: it ends a reply with the
   appraise marker when it has all four, which can be after the first reply if the person
   gave them in the description. `facts` is the net under that: if it cannot name the
   model, the app goes back to the questions (`needs_identity`) rather than search for a
   guess. The "I'm ready to see the market" button, for an assistant that forgets the
   marker, still appears after four replies.
2. **Budget** (`lib/budget.ts`). A step reserves the calls it is about to make, all or
   nothing, counted by what actually runs: one model call for `facts`, three searches
   (and a fourth if it widens) for `search`, one model call for `read` (none when there
   are no sources). Over the daily limit the step is refused (429 `budget_exhausted`)
   before any API is called.
3. **Facts.** One model call with no tools. The price they paid is returned in the
   currency they said it in and **converted by the app** (`VND_PER_USD`), never by the
   model; a detail field the model gets wrong (a price, an age) becomes "unknown" instead
   of failing the lookup. An earlier version rejected "mua 15 triệu" read as fifteen
   million dollars, and so failed every retry.
4. **Queries** (`searchQueries` in `lib/item.ts`). Built by code, not by the model, from
   facts that have had every dollar and đồng amount scrubbed, so they cannot contain what
   the person paid: `"<item> used sold price"` and
   `"<item> used for sale"` on the US sites, and `"<item> cũ"` on Chợ Tốt, Shopee and
   Lazada. When fewer than six sources carry a price, one widening query runs
   (`"<model> used price"`, any site), if the budget allows.
5. **Search** (`lib/search.ts`). Tavily, `search_depth: "basic"` (1 credit), ten
   results per query, the queries **at once**, each restricted to its own sites (eBay,
   Swappa, Mercari, OfferUp, Craigslist, Reverb, Poshmark, Depop, Back Market, Gazelle;
   not Facebook, which needs a login; and the three Vietnamese ones), with each page's
   body as markdown. A 10-second timeout; a timeout, a 5xx or a network error is tried once
   more, nothing else is. One query failing does not lose the rest. Tavily's errors map to
   401 → `search_unavailable`, 432/433 → `search_quota`, 429 → `rate_limited`.
   Shopee and Lazada render with JavaScript, so Tavily may read little of them; Chợ Tốt
   is likelier to give prices.
6. **Sources** (`lib/sources.ts`). Results are numbered `[0]..[n]`, sources with a price
   first, at most 24. A source's text is the search's own summary plus every line of the
   page with a `$` or đồng amount, cut to about 3,000 characters.
7. **Read.** One model call with a response schema and no tools turns the numbered
   sources into listings, each carrying a `sourceIndex`, never a URL. It also reports the
   price of the item new, if a source states one, as `{ priceText, sourceIndex }`. Prices
   in đồng are copied as written; "Đã bán 1,2k" on Shopee or Lazada is how many the shop
   has sold, not a sold listing; only used items count from those three sites.
8. **Ground.** A listing counts only if its `priceText` appears **word for word** in
   the text of the source it cites (whitespace collapsed; `$1,049` does not match
   `US $1,049.99`, nor `500.000 ₫` `5.500.000 ₫`). Otherwise it is shown dimmed and
   left out. The link shown is always the address Tavily returned, never one the model
   wrote. Because the price is checked against the text, list pages and price-guide pages
   count when their price matches. The **new price** is held to the same standard
   (`groundNewPrice`): the source must exist, the price must appear word for word in its
   text, and it must be one amount. A new price that fails is not used as a ceiling, and
   one that passes is linked to the page it came from.
9. **Price** (`lib/pricing.ts`).
   - Prices are parsed from the text as shown ("US $1,049.99", "5.500.000 ₫", "5,5 triệu",
     "5.5tr"); other currencies, ranges and unparseable prices are dropped. Listings in
     đồng are converted to dollars at a **fixed rate** (`VND_PER_USD`, default 26,000;
     deliberately not a live rate, which would be one more service to fail or start
     charging) and go into **the same median** as the dollar ones. The rate travels with
     the listings, so the browser and the server's verdict convert with the same number,
     and the cards show `≈ $212` beside the original `5.500.000 ₫` and a line saying what
     the rate was. A thousands dot (`5.500.000`) is never read as cents.
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

`protocols/protocol_v3.md` holds the assistant. Everything it asks, withholds and
recommends lives in a markdown document sent as the system instruction on every
turn, so editing it edits the intervention. See `protocols/README.md`.

**Never edit a protocol that is in use.** Copy it to the next version and repoint
`PROTOCOL_FILE`.

Only the span between `<!-- GEM CORE START -->` and `<!-- GEM CORE END -->` goes
into the Gemini Gem builder. Four things the app does that a Gem cannot:

1. **The search cannot see their price.** The queries are built by code from facts
   with every dollar amount scrubbed out, and the model that reads the results is
   given the item and never what they paid. A Gem searches inside the same conversation
   where it is on the page.
2. **Sources are verified, not trusted.** A listing is counted only if its price
   appears word for word in the text of the page it cites, and the link shown is the
   address the search returned, never a URL the model wrote. A Gem will cite whatever
   URL it likes and report whatever price it likes.
3. **The market price is computed.** The model reports listings and a position;
   the app does the arithmetic.
4. **Phase order is enforced.** No market lookup before the assistant has said it has what
   it needs (and a photo), no price box before the market is on screen, no verdict before
   there is a market and a locked price.

The phase gate used to count: four assistant replies before the price box. It no longer
does. The assistant decides when it has the four facts and ends that reply with the
appraise marker, which may be the very first reply if the person gave them in their
description; a lookup that cannot name the model sends them back to the questions. The
count survives only as when the "I'm ready to see the market" button appears, for a model
that forgets the marker. `protocols/protocol_v2.md` was left as it was when the market
moved ahead of the price; the new order is `protocols/protocol_v3.md`, and the phase
instructions the app appends (`lib/stages.ts`, `lib/prompts.ts`) are what the model follows.

### What "enforced" means

The server holds no state, so it derives the legal phase from the conversation it
is handed. That guards against **model drift**, which is the real failure mode.
It is not a security boundary: the person holding the conversation could post any
payload they liked, and they are the person being helped, so that is fine. Worth
being precise about rather than overclaiming.

One drift is also caught on the way out. The protocol the model holds contains the
verdict format, so a price typed into the chat while the phase is still the
questions (the market lookup only starts once the model emits the appraise marker, and
the weaker fallback models sometimes do not) was answered with a full verdict that
no market stood behind. Outside the verdict phase, `app/api/chat/route.ts` holds the
first few words of each reply, and one that opens like a verdict (`opensLikeVerdict`)
or begins with the system prompt (`opensLikePrompt`, which the weaker models also
did when handed a price in the chat) is replaced by a line the app writes; once the
questions are done that line sends the person to the market lookup. It only catches a
reply that *starts* that way, and it is a net under the stage instruction rather
than a substitute for it.

## Parameters

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_MODEL` | `gemini-3.6-flash` | Pinned deliberately — see below |
| `PROTOCOL_FILE` | `protocol_v3.md` | Which protocol to load |
| `MAX_TURNS` | `20` | Per-conversation cap, guards the quota |
| `TAVILY_API_KEY` | — | Required to look up the market; read only when an appraisal runs |
| `GEMINI_FALLBACK_MODELS` | `gemini-3.5-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite` | Gemini models tried, in order, after `GEMINI_MODEL`; empty means none |
| `OPENROUTER_API_KEY` | — | Optional free backup; blank means none. Only `:free` models are ever called |
| `OPENROUTER_MODELS` | four named free models, from four providers (see `lib/env.ts`) | Free models tried in order; anything not free is dropped |
| `DEEPSEEK_API_KEY` | — | Optional backup model; blank means none. Prepaid, not free |
| `DEEPSEEK_MODEL` | `deepseek-flash` | Which DeepSeek model the backup uses |
| `VND_PER_USD` | `26000` | Fixed rate listings in đồng are converted at; check it before relying on it |
| `DAILY_SEARCH_BUDGET` | `80` | Tavily calls per UTC day, counted in memory |
| `DAILY_MODEL_BUDGET` | `300` | Gemini calls per UTC day, counted in memory |

**Verify the model before each demo.** Google's catalog moves: at the time of
writing `gemini-2.5-flash` returns 404 for newly created keys, and a busy model can
answer 503 for a while. Real per-model quotas are published only at
<https://aistudio.google.com/rate-limit>. A full appraisal is roughly nine model calls
(up to five conversation turns, the facts, the reading, the verdict) and three or four Tavily credits.

Quota exhaustion is handled rather than hidden: a banner says what ran out and what
to do. A reply that fails half way is withdrawn together with the message it answered,
and that message goes back into the box, so the transcript never holds a question twice.
A market step is retried once by the browser when the failure may pass; nothing else is
retried automatically.

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
