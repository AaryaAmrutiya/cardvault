#!/usr/bin/env python3
"""CardVault local server.

Serves the web interface and proxies the data sources (eBay, PSA, Wikipedia,
TheSportsDB, MLB Stats API) so API keys stay on this machine and never reach
the browser. Standard library only - nothing to install.
"""
import base64
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(ROOT, "static")
CACHE_FILE = os.path.join(ROOT, ".cache.json")
DEFAULT_PORT = 8765
USER_AGENT = "CardVault/1.0 (personal sports card evaluator; local app)"
EBAY_CATEGORY = "261328"  # eBay category: Sports Trading Card Singles
SCOPE_BROWSE = "https://api.ebay.com/oauth/api_scope"
SCOPE_INSIGHTS = "https://api.ebay.com/oauth/api_scope/buy.marketplace.insights"

SPORT_WIKI_HINT = {
    "baseball": "baseball player",
    "basketball": "basketball player",
    "football": "American football player",
    "soccer": "footballer",
}
SPORT_TSDB = {
    "baseball": "Baseball",
    "basketball": "Basketball",
    "football": "American Football",
    "soccer": "Soccer",
}


# ---------------------------------------------------------------- config

def load_env():
    path = os.path.join(ROOT, ".env")
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ[key.strip()] = value.strip().strip('"').strip("'")


def cfg(name, default=""):
    return (os.environ.get(name) or default).strip()


# ---------------------------------------------------------------- cache

class Cache:
    """Small TTL cache persisted to disk so restarts don't burn API quota."""

    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self.data = {}
        try:
            with open(path, encoding="utf-8") as f:
                self.data = json.load(f)
        except (OSError, ValueError):
            self.data = {}

    def get(self, key):
        with self.lock:
            entry = self.data.get(key)
            if entry and entry["exp"] > time.time():
                return entry["val"]
            return None

    def set(self, key, val, ttl):
        with self.lock:
            now = time.time()
            self.data = {k: v for k, v in self.data.items() if v["exp"] > now}
            self.data[key] = {"exp": now + ttl, "val": val}
            try:
                tmp = self.path + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(self.data, f)
                os.replace(tmp, self.path)
            except OSError:
                pass


CACHE = Cache(CACHE_FILE)


# ---------------------------------------------------------------- http

class UpstreamError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def user_agent():
    contact = cfg("CONTACT")
    return f"{USER_AGENT[:-1]}; {contact})" if contact else USER_AGENT


def fetch_json(url, headers=None, data=None, timeout=25, retries=2):
    h = {"User-Agent": user_agent(), "Accept": "application/json"}
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=h, method="POST" if data is not None else "GET")
    host = urllib.parse.urlparse(url).netloc
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", "replace")
            return json.loads(body) if body.strip() else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:400]
        if e.code == 429 and retries > 0 and ("wikipedia" in host or "wikimedia" in host or "wikidata" in host):
            try:
                wait = min(float(e.headers.get("Retry-After") or 2), 10)
            except ValueError:
                wait = 2
            time.sleep(wait)
            return fetch_json(url, headers, data, timeout, retries - 1)
        raise UpstreamError(e.code, f"{host} returned {e.code}: {detail.splitlines()[0] if detail else ''}")
    except urllib.error.URLError as e:
        raise UpstreamError(502, f"Could not reach {host}: {e.reason}")
    except TimeoutError:
        raise UpstreamError(504, f"{host} timed out")
    except ValueError:
        raise UpstreamError(502, f"{host} returned data that was not JSON")


# ---------------------------------------------------------------- eBay

_tokens = {}
_token_lock = threading.Lock()


def ebay_configured():
    return bool(cfg("EBAY_CLIENT_ID") and cfg("EBAY_CLIENT_SECRET"))


def ebay_token(scope):
    if not ebay_configured():
        raise UpstreamError(503, "eBay keys are not configured yet (see Setup).")
    with _token_lock:
        tok = _tokens.get(scope)
        if tok and tok[1] > time.time() + 60:
            return tok[0]
        creds = base64.b64encode(f"{cfg('EBAY_CLIENT_ID')}:{cfg('EBAY_CLIENT_SECRET')}".encode()).decode()
        body = urllib.parse.urlencode({"grant_type": "client_credentials", "scope": scope}).encode()
        res = fetch_json(
            "https://api.ebay.com/identity/v1/oauth2/token",
            {"Authorization": f"Basic {creds}", "Content-Type": "application/x-www-form-urlencoded"},
            body,
        )
        _tokens[scope] = (res["access_token"], time.time() + int(res.get("expires_in", 7200)))
        return res["access_token"]


def _money(obj):
    try:
        return float((obj or {}).get("value"))
    except (TypeError, ValueError):
        return None


def ebay_search(qs):
    q = require(qs, "q")
    token = ebay_token(SCOPE_BROWSE)
    url = "https://api.ebay.com/buy/browse/v1/item_summary/search?" + urllib.parse.urlencode(
        {"q": q, "category_ids": EBAY_CATEGORY, "limit": "200"}
    )
    res = fetch_json(url, {"Authorization": f"Bearer {token}", "X-EBAY-C-MARKETPLACE-ID": "EBAY_US"})
    items = []
    for it in res.get("itemSummaries") or []:
        price = _money(it.get("price")) or _money(it.get("currentBidPrice"))
        ship_opts = it.get("shippingOptions") or []
        shipping = _money(ship_opts[0].get("shippingCost")) if ship_opts else None
        image = (it.get("image") or {}).get("imageUrl")
        if not image and it.get("thumbnailImages"):
            image = it["thumbnailImages"][0].get("imageUrl")
        items.append({
            "title": it.get("title", ""),
            "price": price,
            "currency": (it.get("price") or it.get("currentBidPrice") or {}).get("currency", "USD"),
            "shipping": shipping,
            "url": it.get("itemWebUrl"),
            "image": image,
            "created": it.get("itemCreationDate"),
            "buying": it.get("buyingOptions") or [],
            "bids": it.get("bidCount") or 0,
            "seller": (it.get("seller") or {}).get("username"),
            "condition": it.get("condition"),
        })
    return {"query": q, "total": res.get("total", len(items)), "items": items}


def ebay_sold(qs):
    q = require(qs, "q")
    if not ebay_configured():
        return {"available": False, "reason": "eBay keys are not configured yet."}
    if CACHE.get("ebay:insights:denied"):
        return {"available": False, "reason": CACHE.get("ebay:insights:denied")}
    denied = ("Your eBay app does not have Marketplace Insights (sold data) access. "
              "Values use current asking prices instead.")
    try:
        token = ebay_token(SCOPE_INSIGHTS)
        url = "https://api.ebay.com/buy/marketplace_insights/v1_beta/item_sales/search?" + urllib.parse.urlencode(
            {"q": q, "category_ids": EBAY_CATEGORY, "limit": "200"}
        )
        res = fetch_json(url, {"Authorization": f"Bearer {token}", "X-EBAY-C-MARKETPLACE-ID": "EBAY_US"})
    except UpstreamError as e:
        if e.status in (400, 401, 403):
            CACHE.set("ebay:insights:denied", denied, 6 * 3600)
            return {"available": False, "reason": denied}
        raise
    sales = []
    for it in res.get("itemSales") or []:
        image = (it.get("image") or {}).get("imageUrl")
        sales.append({
            "title": it.get("title", ""),
            "price": _money(it.get("lastSoldPrice")),
            "currency": (it.get("lastSoldPrice") or {}).get("currency", "USD"),
            "date": it.get("lastSoldDate"),
            "qty": int(it.get("totalSoldQuantity") or 1),
            "url": it.get("itemWebUrl"),
            "image": image,
            "buying": it.get("buyingOptions") or [],
        })
    return {"available": True, "query": q, "total": res.get("total", len(sales)), "items": sales}


# ---------------------------------------------------------------- PSA

def psa_get(path):
    token = cfg("PSA_API_TOKEN")
    if not token:
        raise UpstreamError(503, "PSA token is not configured (see Setup).")
    try:
        res = fetch_json("https://api.psacard.com/publicapi/" + path, {"Authorization": f"bearer {token}"})
    except UpstreamError as e:
        if e.status == 403 and "approved" in str(e).lower():
            CACHE.set("psa:denied", True, 3600)
            raise UpstreamError(403, "PSA hasn't approved your account for API access yet. "
                                     "Email collectors-apis@collectors.com to request Public API access.")
        if e.status == 429:
            raise UpstreamError(429, "PSA's daily limit (100 lookups) has been reached. It resets tomorrow.")
        raise
    CACHE.set("psa:denied", False, 3600)
    return res


def psa_cert(qs):
    cert = "".join(ch for ch in require(qs, "cert") if ch.isdigit())
    if not cert:
        raise ValueError("A PSA cert number contains digits only.")
    return psa_get(f"cert/GetByCertNumber/{cert}")


def psa_pop(qs):
    spec = "".join(ch for ch in require(qs, "spec") if ch.isdigit())
    if not spec:
        raise ValueError("Invalid PSA spec ID.")
    return psa_get(f"pop/GetPSASpecPopulation/{spec}")


# ---------------------------------------------------------------- players

def wiki_player(name, sport):
    search = fetch_json("https://en.wikipedia.org/w/api.php?" + urllib.parse.urlencode({
        "action": "query", "list": "search", "format": "json", "srlimit": "6",
        "srsearch": f"{name} {SPORT_WIKI_HINT.get(sport, '')}",
    }))
    hits = (search.get("query") or {}).get("search") or []
    wanted = name.lower().strip()
    last = wanted.split()[-1] if wanted.split() else ""

    def rank(hit):
        title = hit["title"].lower()
        if title == wanted:
            return 0
        if title.startswith(wanted + " ("):
            return 1
        if title.startswith(wanted):
            return 2
        return 3 if last and last in title else 4

    ordered = sorted(hits, key=rank)
    for hit in ordered[:3]:
        title = hit["title"]
        summary = fetch_json("https://en.wikipedia.org/api/rest_v1/page/summary/" + urllib.parse.quote(title.replace(" ", "_"), safe=""))
        if summary.get("type") == "disambiguation":
            continue
        canonical = (summary.get("titles") or {}).get("canonical") or title.replace(" ", "_")
        end = datetime.now(timezone.utc).date() - timedelta(days=1)
        start = end - timedelta(days=59)
        views = []
        try:
            pv = fetch_json(
                "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/"
                f"{urllib.parse.quote(canonical, safe='')}/daily/{start:%Y%m%d}/{end:%Y%m%d}"
            )
            views = [int(i.get("views", 0)) for i in pv.get("items") or []]
        except UpstreamError:
            pass
        return {
            "title": summary.get("title", title),
            "wikidata": summary.get("wikibase_item"),
            "url": ((summary.get("content_urls") or {}).get("desktop") or {}).get("page"),
            "description": summary.get("description"),
            "extract": summary.get("extract"),
            "thumbnail": (summary.get("thumbnail") or {}).get("source"),
            "views": views,
            "viewsStart": f"{start:%Y-%m-%d}",
            "viewsEnd": f"{end:%Y-%m-%d}",
        }
    return None


def wikidata_awards(qid):
    """Awards recorded on Wikidata (property P166, 'award received')."""
    if not qid:
        return None
    claims = fetch_json("https://www.wikidata.org/w/api.php?" + urllib.parse.urlencode(
        {"action": "wbgetclaims", "entity": qid, "property": "P166", "format": "json"}))
    raw = []
    for claim in (claims.get("claims") or {}).get("P166") or []:
        value = ((claim.get("mainsnak") or {}).get("datavalue") or {}).get("value") or {}
        award_id = value.get("id")
        if not award_id:
            continue
        year = None
        for q in ((claim.get("qualifiers") or {}).get("P585") or []):
            t = ((q.get("datavalue") or {}).get("value") or {}).get("time", "")
            if len(t) >= 5:
                year = t[1:5]
        raw.append((award_id, year))
    labels = {}
    ids = sorted({a for a, _ in raw})
    for i in range(0, len(ids), 50):
        ents = fetch_json("https://www.wikidata.org/w/api.php?" + urllib.parse.urlencode({
            "action": "wbgetentities", "ids": "|".join(ids[i:i + 50]),
            "props": "labels", "languages": "en", "format": "json"}))
        for eid, ent in (ents.get("entities") or {}).items():
            labels[eid] = (((ent.get("labels") or {}).get("en") or {}).get("value")) or eid
    return [{"name": labels.get(a, a), "year": y} for a, y in raw]


def tsdb_player(name, sport):
    key = cfg("THESPORTSDB_KEY", "123")
    res = fetch_json(f"https://www.thesportsdb.com/api/v1/json/{key}/searchplayers.php?" + urllib.parse.urlencode({"p": name}))
    players = [p for p in (res.get("player") or []) if (p.get("strSport") or "") == SPORT_TSDB.get(sport)]
    if not players:
        return None
    p = players[0]
    honours = []
    try:
        h = fetch_json(f"https://www.thesportsdb.com/api/v1/json/{key}/lookuphonours.php?id={p.get('idPlayer')}")
        honours = [{"title": x.get("strHonour"), "season": x.get("strSeason"), "team": x.get("strTeam")}
                   for x in (h.get("honours") or []) if x.get("strHonour")]
    except UpstreamError:
        pass
    return {
        "id": p.get("idPlayer"),
        "name": p.get("strPlayer"),
        "team": p.get("strTeam"),
        "nationality": p.get("strNationality"),
        "position": p.get("strPosition"),
        "born": p.get("dateBorn"),
        "status": p.get("strStatus"),
        "honours": honours,
    }


def mlb_player(name):
    res = fetch_json("https://statsapi.mlb.com/api/v1/people/search?" + urllib.parse.urlencode({"names": name, "sportIds": "1"}))
    people = res.get("people") or []
    if not people:
        return None
    pid = people[0]["id"]
    detail = fetch_json(f"https://statsapi.mlb.com/api/v1/people/{pid}?" + urllib.parse.urlencode(
        {"hydrate": "awards,stats(group=[hitting,pitching],type=[career])"}))
    p = (detail.get("people") or [{}])[0]
    career = {}
    for block in p.get("stats") or []:
        group = (block.get("group") or {}).get("displayName")
        splits = block.get("splits") or []
        if group and splits:
            career[group] = splits[0].get("stat") or {}
    return {
        "id": pid,
        "name": p.get("fullName"),
        "active": p.get("active"),
        "debut": p.get("mlbDebutDate"),
        "position": (p.get("primaryPosition") or {}).get("name"),
        "team": (p.get("currentTeam") or {}).get("name"),
        "awards": [{"name": a.get("name"), "season": a.get("season")} for a in p.get("awards") or []],
        "career": career,
    }


def player(qs):
    name = require(qs, "name")
    sport = qs.get("sport", "baseball")
    jobs = {"wiki": lambda: wiki_player(name, sport), "tsdb": lambda: tsdb_player(name, sport)}
    if sport == "baseball":
        jobs["mlb"] = lambda: mlb_player(name)
    out, errors = {}, []
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = {k: pool.submit(fn) for k, fn in jobs.items()}
        for key, fut in futures.items():
            try:
                out[key] = fut.result()
            except Exception as e:  # one source failing should not sink the others
                out[key] = None
                errors.append(f"{key}: {e}")
    out["awards"] = None
    if out.get("wiki") and out["wiki"].get("wikidata"):
        try:
            out["awards"] = wikidata_awards(out["wiki"]["wikidata"])
        except Exception as e:
            errors.append(f"wikidata: {e}")
    out["errors"] = errors
    return out


# ---------------------------------------------------------------- routes

def require(qs, name):
    value = (qs.get(name) or "").strip()
    if not value:
        raise ValueError(f"Missing required parameter '{name}'.")
    return value


def status(_qs):
    return {
        "ebay": ebay_configured(),
        "psa": bool(cfg("PSA_API_TOKEN")),
        "psaApproved": None if CACHE.get("psa:denied") is None else not CACHE.get("psa:denied"),
        "players": True,
        "insights": None if not ebay_configured() else not CACHE.get("ebay:insights:denied"),
    }


def cached(prefix, ttl, fn):
    def wrapper(qs):
        key = prefix + json.dumps(qs, sort_keys=True)
        hit = CACHE.get(key)
        if hit is not None:
            return hit
        val = fn(qs)
        CACHE.set(key, val, ttl)
        return val
    return wrapper


ROUTES = {
    "/api/status": status,
    "/api/ebay/search": cached("ebay:search:", 30 * 60, ebay_search),
    "/api/ebay/sold": cached("ebay:sold:", 60 * 60, ebay_sold),
    "/api/psa/cert": cached("psa:cert:", 7 * 86400, psa_cert),
    "/api/psa/pop": cached("psa:pop:", 3 * 86400, psa_pop),
    "/api/player": cached("player:", 12 * 3600, player),
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def log_message(self, fmt, *args):
        if self.path.startswith("/api/"):
            sys.stderr.write(f"  {self.command} {self.path.split('?')[0]} -> {args[1] if len(args) > 1 else ''}\n")

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith("/api/"):
            return self.handle_api(parsed)
        return super().do_GET()

    def handle_api(self, parsed):
        route = ROUTES.get(parsed.path)
        if not route:
            return self.send_json(404, {"error": "Unknown endpoint."})
        qs = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}
        try:
            self.send_json(200, route(qs))
        except UpstreamError as e:
            self.send_json(e.status if 400 <= e.status < 600 else 502, {"error": str(e)})
        except ValueError as e:
            self.send_json(400, {"error": str(e)})
        except Exception as e:
            self.send_json(500, {"error": f"Unexpected server error: {e}"})

    def send_json(self, status_code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    load_env()
    port = int(cfg("PORT", str(DEFAULT_PORT)))
    server = None
    for candidate in range(port, port + 20):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", candidate), Handler)
            port = candidate
            break
        except OSError:
            continue
    if server is None:
        sys.exit("Could not find a free port to run on.")
    url = f"http://127.0.0.1:{port}"
    print(f"\n  CardVault is running at {url}")
    print(f"  eBay: {'connected' if ebay_configured() else 'not configured'}   "
          f"PSA: {'connected' if cfg('PSA_API_TOKEN') else 'not configured'}")
    print("  Close this window (or press Ctrl+C) to stop.\n")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
