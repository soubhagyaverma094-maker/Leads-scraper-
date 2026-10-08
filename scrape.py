"""
Finds businesses that are hiring marketing / design / content people on
Indeed, Naukri and LinkedIn (via the free python-jobspy library), removes
agencies, and sends the companies to your Lead desk (/api/ingest).
The Lead desk then finds each phone number with Google Places.
"""
import json
import os
import random
import re
import sys
import time
import urllib.request

from jobspy import scrape_jobs

APP = os.environ["APP_URL"].rstrip("/")
KEY = os.environ["INGEST_SECRET"]
RUN_ID = "run_" + os.environ.get("RUN_ID", str(int(time.time())))
SITES = [x.strip() for x in os.environ.get("SITES", "indeed,naukri,linkedin").split(",") if x.strip()]
COUNTRY = os.environ.get("COUNTRY", "India")
MAX_MINUTES = 20

BAD_NAME = re.compile(
    r"\b(digital|marketing|seo|advertis\w*|agency|agencies|web\s?(design\w*|develop\w*|solutions?)|website\w*|software|"
    r"info\s?tech|infotech|it\s?(solutions?|services?)|technolog\w*|technologies|tech|media|branding|creatives?|"
    r"app\s?develop\w*|staffing|recruit\w*|placements?|manpower|consultanc\w*|consultants?|hr\s?solutions?|talent|"
    r"headhunt\w*|outsourc\w*)\b",
    re.I,
)
BAD_DESC = re.compile(
    r"(digital marketing (agency|company)|marketing agency|advertising agency|seo (company|agency)|"
    r"web (design|development) (company|agency)|software (development )?company|we are a .{0,40}(agency|consultancy|staffing))",
    re.I,
)


def http(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        APP + path,
        data=data,
        method=method,
        headers={"content-type": "application/json", "x-ingest-key": KEY, "user-agent": "leaddesk-action"},
    )
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read() or b"{}")


def clean(v):
    if v is None or (isinstance(v, float) and v != v):
        return ""
    return str(v).strip()


def slug(x):
    return re.sub(r"[^a-z0-9]+", "-", x.lower()).strip("-")


def main():
    try:
        cfg = http("GET", "/api/config")
    except Exception as e:  # keep going with defaults if the app is unreachable
        print("Could not read settings from the app:", e)
        sys.exit(1)

    per_day = int(cfg.get("perDay", 100))
    cities = cfg.get("cities") or ["Raipur"]
    terms = cfg.get("terms") or ["digital marketing executive"]
    print(f"Target {per_day} leads | {len(cities)} cities | {len(terms)} job titles | sites {SITES}")

    combos = [(t, c) for t in terms for c in cities]
    random.shuffle(combos)

    found = {}  # company slug -> lead
    prefiltered = 0
    started = time.time()
    want = per_day * 3  # extra, because many companies will have no phone on Google

    for term, city in combos:
        if len(found) >= want or time.time() - started > MAX_MINUTES * 60:
            break
        for site in SITES:
            try:
                df = scrape_jobs(
                    site_name=[site],
                    search_term=term,
                    location=f"{city}, {COUNTRY}",
                    results_wanted=25,
                    hours_old=24 * 7,
                    country_indeed=COUNTRY,
                )
            except Exception as e:
                print(f"  {site} failed for '{term}' in {city}: {str(e)[:100]}")
                continue
            if df is None or len(df) == 0:
                continue
            for row in df.to_dict("records"):
                name = clean(row.get("company"))
                if not name:
                    continue
                key = slug(name)
                if key in found:
                    continue
                if BAD_NAME.search(name) or BAD_DESC.search(clean(row.get("description"))[:1500]):
                    prefiltered += 1
                    continue
                found[key] = {
                    "name": name,
                    "city": city,
                    "jobTitle": clean(row.get("title")),
                    "source": site,
                    "jobUrl": clean(row.get("job_url")),
                    "email": clean(row.get("emails")).split(",")[0].strip(),
                }
            time.sleep(1)
        print(f"{term} / {city}: {len(found)} companies so far")

    leads = list(found.values())
    random.shuffle(leads)
    print(f"Collected {len(leads)} companies, {prefiltered} agencies removed before sending")

    added = 0
    for i in range(0, len(leads), 15):
        batch = leads[i : i + 15]
        try:
            res = http("POST", "/api/ingest", {"runId": RUN_ID, "leads": batch, "preFiltered": prefiltered if i == 0 else 0})
        except Exception as e:
            print("Send failed:", e)
            continue
        added = res.get("added", added)
        print(f"Sent {i + len(batch)}/{len(leads)} | saved so far: {added}")
        if res.get("full"):
            break

    if not leads:
        http("POST", "/api/ingest", {"runId": RUN_ID, "leads": [], "preFiltered": prefiltered})
    print("Done. Leads saved:", added)


if __name__ == "__main__":
    main()
