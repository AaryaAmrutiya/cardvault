# CardVault Outline

Cardvault is an outline of the final project which values your specific card using PSA and eBay's API to fetch data accurately.

Evaluate any Topps / Bowman sports card (baseball, basketball, football, soccer) with
evidence-backed ratings and a value estimate.

## Run it

Double-click `start.bat` (or run `python server.py`). Your browser opens at
[http://127.0.0.1:8765](https://cardvault-3v3v.onrender.com/). Close the black window to stop the app.

## Data sources

| Source | Used for | Setup |
|---|---|---|
| eBay Browse API | live listings → value, demand, liquidity, rarity, momentum | `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` in `.env` |
| eBay Marketplace Insights | real sold prices (much better estimates) | needs approval from eBay; used automatically if granted |
| PSA Public API | population report, gem rate, grade standing | `PSA_API_TOKEN` in `.env` + account approval from PSA |
| Wikipedia + pageviews | player profile, fame, attention trend | none |
| Wikidata | player awards (all sports) | none |
| MLB Stats API | MLB awards and career stats | none |
| Sold prices you enter | value + momentum when eBay isn't connected | none |

Edit `.env`, then restart the app.

## The ratings

Every rating is 0–100 and its card in the app lists the evidence and the formula.
Missing data is skipped and the remaining inputs re-weighted. Ratings show
"Not enough data" instead of guessing.

- **Rarity**: serial numbering, PSA population, market supply
- **Collector Appeal**: rookie, 1st Bowman, auto, low serial, vintage, gem grade, bidding
- **Demand**: sales volume, auction bidding, player attention
- **Player Importance**: Wikipedia attention, Wikidata honours, MLB major awards, Hall of Fame
- **Grading Potential**: PSA 10 premium over raw, gem rate (graded cards get *Grade Standing* instead)
- **Market Liquidity**: sales volume, listing count, seller count, price spread
- **Recent Momentum**: sale-price trend, new vs old asks, attention trend

## Files

- `server.py`: local server and API proxy (Python standard library only)
- `static/scoring.js`: rating formulas and valuation
- `static/app.js`: interface logic
- `.env`: your keys (never share this file)
