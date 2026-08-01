from owrx.controllers import Controller
from owrx.config import Config
from datetime import datetime, timezone
import json
import time
import math
import threading
import urllib.request

import logging

logger = logging.getLogger(__name__)

# Öffentliche, kostenlose Ausbreitungs-Datenquellen. Beide werden serverseitig
# geholt, gecacht und zu einem schlanken JSON gemerged, damit weder CORS noch die
# LAN-Situation der Besucher stören und die Freiwilligen-Dienste nicht von jedem
# Browser einzeln getroffen werden.
KC2G_URL = "https://prop.kc2g.com/api/stations.json"       # Echtzeit-Ionosonden -> MUF
NOAA_K_URL = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json"  # planetarer Kp
USER_AGENT = "OpenWebRX-DG7LAN propagation badges (+https://dg7lan.mooo.com)"

# Ausbreitung ändert sich langsam -> großzügig cachen (guter Umgang mit den Diensten).
MUF_TTL = 900     # 15 min (Ionosonden aktualisieren etwa alle 15 min)
K_TTL = 1800      # 30 min (Kp ist 3-stündlich)
HTTP_TIMEOUT = 8
STALE_AFTER_MIN = 120  # MUF-Messung älter als das -> als "stale" markieren/abwerten

_lock = threading.Lock()
_cache = {"muf": {"ts": 0.0, "data": None}, "k": {"ts": 0.0, "data": None}}


def _fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
        return json.loads(r.read().decode())


def _cached(kind, ttl, producer):
    now = time.time()
    with _lock:
        entry = _cache[kind]
        if entry["data"] is not None and now - entry["ts"] < ttl:
            return entry["data"]
    try:
        data = producer()
    except Exception as e:
        logger.warning("propagation: fetch '%s' failed: %s", kind, e)
        with _lock:
            # bei Fehler ggf. letzten (veralteten) Stand weiterreichen, statt nichts
            return _cache[kind]["data"]
    with _lock:
        _cache[kind] = {"ts": now, "data": data}
    return data


def _haversine_km(lat1, lon1, lat2, lon2):
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def _age_min(iso):
    if not iso:
        return None
    try:
        t = datetime.strptime(iso[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
        return max(0.0, (datetime.now(timezone.utc) - t).total_seconds() / 60.0)
    except (ValueError, TypeError):
        return None


def _pick_muf(stations, lat, lon):
    # Nächstgelegene Ionosonde mit gültigem MUF(D) wählen; frische Messungen
    # bevorzugen (nicht-stale schlägt stale, dann kürzeste Distanz).
    best = None
    best_key = None
    for s in stations:
        muf = s.get("mufd")
        st = s.get("station") or {}
        if muf is None:
            continue
        try:
            slat = float(st["latitude"])
            slon = float(st["longitude"])
            muf = float(muf)
        except (KeyError, TypeError, ValueError):
            continue
        dist = _haversine_km(lat, lon, slat, slon)
        age = _age_min(s.get("time"))
        stale = age is not None and age > STALE_AFTER_MIN
        key = (stale, dist)
        if best_key is None or key < best_key:
            best_key = key
            best = {
                "mhz": round(muf, 1),
                "station": st.get("name"),
                "code": st.get("code"),
                "dist_km": round(dist),
                "cs": s.get("cs"),
                "age_min": round(age) if age is not None else None,
                "stale": stale,
                "source": s.get("source"),
            }
    return best


def _produce_muf(lat, lon):
    stations = _fetch_json(KC2G_URL)
    if not isinstance(stations, list):
        return None
    return _pick_muf(stations, lat, lon)


def _rows_to_dicts(rows):
    # Robust gegen beide Formate: Objekt-Liste (aktuell) oder Array-of-Arrays mit Kopfzeile.
    if rows and isinstance(rows[0], list):
        header = rows[0]
        return [dict(zip(header, r)) for r in rows[1:]]
    return rows


def _produce_k():
    rows = _rows_to_dicts(_fetch_json(NOAA_K_URL))
    latest = None
    for row in rows:
        kp = row.get("Kp")
        if kp is None:
            continue
        if latest is None or str(row.get("time_tag", "")) > str(latest.get("time_tag", "")):
            latest = row
    if latest is None:
        return None
    kp = float(latest["Kp"])
    level = "quiet" if kp < 3 else "unsettled" if kp < 4 else "active" if kp < 5 else "storm"
    age = _age_min(latest.get("time_tag"))
    return {
        "kp": round(kp, 1),
        "level": level,
        "a": latest.get("a_running"),
        "age_min": round(age) if age is not None else None,
    }


class PropagationSummaryController(Controller):
    def indexAction(self):
        pm = Config.get()
        gps = pm["receiver_gps"]
        try:
            lat = float(gps["lat"])
            lon = float(gps["lon"])
        except (KeyError, TypeError, ValueError):
            lat, lon = 0.0, 0.0
        result = {
            "muf": _cached("muf", MUF_TTL, lambda: _produce_muf(lat, lon)),
            "k": _cached("k", K_TTL, _produce_k),
            "ts": int(time.time()),
        }
        # 5 min Browser-Cache; die eigentliche Drosselung sitzt im Server-Cache oben.
        self.send_response(json.dumps(result), content_type="application/json", max_age=300)
