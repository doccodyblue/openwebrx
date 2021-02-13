from datetime import datetime, timezone
import json
import os

import logging

logger = logging.getLogger(__name__)


class Bookmark(object):
    def __init__(self, j):
        self.name = j["name"]
        self.frequency = j["frequency"]
        self.modulation = j["modulation"]

    def getName(self):
        return self.name

    def getFrequency(self):
        return self.frequency

    def getModulation(self):
        return self.modulation

    def __dict__(self):
        return {
            "name": self.getName(),
            "frequency": self.getFrequency(),
            "modulation": self.getModulation(),
        }


class Bookmarks(object):
    sharedInstance = None

    @staticmethod
    def getSharedInstance():
        if Bookmarks.sharedInstance is None:
            Bookmarks.sharedInstance = Bookmarks()
        return Bookmarks.sharedInstance

    def __init__(self):
        self.file_modified = None
        self.bookmarks = []
        self.fileList = ["/etc/openwebrx/bookmarks.json", "bookmarks.json"]

    def _refresh(self):
        modified = self._getFileModifiedTimestamp()
        if self.file_modified is None or modified > self.file_modified:
            logger.debug("reloading bookmarks from disk due to file modification")
            self.bookmarks = self._loadBookmarks()
            self.file_modified = modified

    def _getFileModifiedTimestamp(self):
        timestamp = 0
        for file in self.fileList:
            try:
                timestamp = os.path.getmtime(file)
                break
            except FileNotFoundError:
                pass
        return datetime.fromtimestamp(timestamp, timezone.utc)

    def _loadBookmarks(self):
        for file in self.fileList:
            try:
                f = open(file, "r")
                bookmarks_json = json.load(f)
                f.close()
                return [Bookmark(d) for d in bookmarks_json]
            except FileNotFoundError:
                pass
            except json.JSONDecodeError:
                logger.exception("error while parsing bookmarks file %s", file)
                return []
            except Exception:
                logger.exception("error while processing bookmarks from %s", file)
                return []
        return []

    def getBookmarks(self, range):
        self._refresh()
        (lo, hi) = range
        return [b for b in self.bookmarks if lo <= b.getFrequency() <= hi]
