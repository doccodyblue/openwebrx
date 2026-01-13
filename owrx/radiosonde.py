"""
Radiosonde decoder integration for OpenWebRX+
Handles parsing JSON output from rs41mod/dfm09mod and map display.
"""

from owrx.toolbox import TextParser
from owrx.map import Map, LatLngLocation
from owrx.config import Config
from datetime import datetime
import threading
import json
import logging

logger = logging.getLogger(__name__)


# Radiosonde icon - balloon symbol
SONDE_SYMBOL = {"x": 2, "y": 0}  # Balloon symbol in APRS icon set


class RadiosondeLocation(LatLngLocation):
    """
    Location object for radiosondes compatible with OpenWebRX map.
    """
    def __init__(self, data):
        super().__init__(data["lat"], data["lon"])
        self.data = data

    def getSymbol(self):
        return SONDE_SYMBOL

    def __dict__(self):
        res = super(RadiosondeLocation, self).__dict__()
        res["symbol"] = self.getSymbol()
        # Map sonde data to display fields
        if "id" in self.data:
            res["callsign"] = self.data["id"]
        if "altitude" in self.data:
            res["altitude"] = self.data["altitude"]
        if "vel_v" in self.data:
            res["vspeed"] = self.data["vel_v"]
        if "vel_h" in self.data:
            res["speed"] = self.data["vel_h"]
        if "heading" in self.data:
            res["course"] = self.data["heading"]
        if "temp" in self.data:
            res["temp"] = self.data["temp"]
        if "humidity" in self.data:
            res["humidity"] = self.data["humidity"]
        if "sats" in self.data:
            res["sats"] = self.data["sats"]
        if "type" in self.data:
            res["mode"] = self.data["type"]
        if "frame" in self.data:
            res["frame"] = self.data["frame"]
        if "freq" in self.data:
            res["freq"] = self.data["freq"]
        if "ttl" in self.data:
            res["ttl"] = self.data["ttl"]
        return res


class RadiosondeManager:
    """
    Global manager for tracking radiosondes.
    Maintains state and updates the map.
    """
    sharedInstance = None
    creationLock = threading.Lock()

    @staticmethod
    def getSharedInstance():
        with RadiosondeManager.creationLock:
            if RadiosondeManager.sharedInstance is None:
                RadiosondeManager.sharedInstance = RadiosondeManager()
        return RadiosondeManager.sharedInstance

    def __init__(self):
        self.lock = threading.Lock()
        self.sondes = {}  # sonde_id -> last_data
        self.ttl = 600  # 10 minutes TTL for sondes

    def update(self, data):
        """Update sonde position and push to map."""
        sonde_id = data.get("id")
        if not sonde_id:
            return

        with self.lock:
            # Update internal tracking
            data["ttl"] = self.ttl
            data["timestamp"] = datetime.now().timestamp() * 1000
            self.sondes[sonde_id] = data

            # Push to map
            if "lat" in data and "lon" in data:
                loc = RadiosondeLocation(data)
                Map.getSharedInstance().updateLocation(
                    sonde_id, loc, "Radiosonde"
                )
                logger.debug(f"Radiosonde {sonde_id}: {data['lat']:.5f}, {data['lon']:.5f}, {data.get('altitude', 0):.0f}m")

    def cleanup(self):
        """Remove expired sondes."""
        now = datetime.now().timestamp() * 1000
        with self.lock:
            expired = [k for k, v in self.sondes.items()
                      if now - v.get("timestamp", 0) > self.ttl * 1000]
            for k in expired:
                del self.sondes[k]


class RadiosondeParser(TextParser):
    """
    Parser for radiosonde decoder JSON output.
    """
    def __init__(self, sondeType: str = "RS41", filePrefix: str = None, service: bool = False):
        self.sondeType = sondeType
        super().__init__(filePrefix=filePrefix or f"SONDE_{sondeType}", service=service)

    def parse(self, msg: bytes):
        """Parse JSON message from radiosonde decoder."""
        try:
            # Skip empty lines
            line = msg.decode('utf-8', errors='ignore').strip()
            if not line or not line.startswith('{'):
                return None

            data = json.loads(line)

            # Validate required fields
            if "lat" not in data or "lon" not in data:
                return None

            # Add metadata
            data["type"] = self.sondeType
            data["mode"] = self.sondeType
            if self.frequency != 0:
                data["freq"] = self.frequency

            # Normalize field names (rs41mod uses different names)
            if "alt" in data and "altitude" not in data:
                data["altitude"] = data["alt"]

            # Update manager (for map display)
            RadiosondeManager.getSharedInstance().update(data)

            # Return data for panel display (unless service mode)
            if not self.service:
                logger.info(f"Radiosonde panel data: mode={data.get('mode')}, id={data.get('id')}")
            return None if self.service else data

        except json.JSONDecodeError as e:
            logger.debug(f"JSON parse error: {e}")
            return None
        except Exception as e:
            logger.warning(f"Radiosonde parse error: {e}")
            return None

    def setDialFrequency(self, frequency: int) -> None:
        self.frequency = frequency
