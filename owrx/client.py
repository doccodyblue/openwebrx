from owrx.config import Config
from owrx.config.core import CoreConfig
from owrx.color import ColorCache
from datetime import datetime, timedelta
from ipaddress import ip_address, ip_network
from http.cookies import SimpleCookie
import threading
import re
import json
import os

import logging

logger = logging.getLogger(__name__)

# Persistent chat history file
CHAT_HISTORY_FILE = "/var/lib/openwebrx/chat_history.json"

# Unbegrenztes Text-Log aller Chat-Nachrichten (append-only, zum Nachlesen)
CHAT_LOG_FILE = "/var/lib/openwebrx/chat_log.txt"
# Persistent ban list (IPs plus per-browser cookie tokens), survives restarts
BANS_FILE = "/var/lib/openwebrx/bans.json"
# Cookie carrying the per-browser client token (set by IndexController)
CLIENT_TOKEN_COOKIE = "owrx_cid"


class TooManyClientsException(Exception):
    pass


class BannedClientException(Exception):
    pass


class ClientRegistry(object):
    sharedInstance = None
    creationLock = threading.Lock()

    @staticmethod
    def getSharedInstance():
        with ClientRegistry.creationLock:
            if ClientRegistry.sharedInstance is None:
                ClientRegistry.sharedInstance = ClientRegistry()
        return ClientRegistry.sharedInstance

    def __init__(self):
        self.clients = []
        self.bans = self._loadBans()
        self.chat = {}
        self.chatCount = 1
        self.chatColors = ColorCache()
        self.chatLock = threading.Lock()
        self.chatHistoryMax = 100  # Max. Anzahl gespeicherter Nachrichten
        self.chatHistory = self._loadChatHistory()  # Load from disk
        Config.get().wireProperty("max_clients", self._checkClientCount)
        super().__init__()

    def _loadChatHistory(self):
        """Load chat history from disk"""
        try:
            if os.path.exists(CHAT_HISTORY_FILE):
                with open(CHAT_HISTORY_FILE, 'r') as f:
                    history = json.load(f)
                    logger.info("Loaded %d chat messages from disk", len(history))
                    return history[-self.chatHistoryMax:]  # Limit to max
        except Exception as e:
            logger.warning("Could not load chat history: %s", e)
        return []

    def _saveChatHistory(self):
        """Save chat history to disk"""
        try:
            with open(CHAT_HISTORY_FILE, 'w') as f:
                json.dump(self.chatHistory, f)
        except Exception as e:
            logger.warning("Could not save chat history: %s", e)

    def _appendChatLog(self, name, text):
        """Append message to the unlimited plain-text chat log"""
        try:
            with open(CHAT_LOG_FILE, 'a') as f:
                f.write("%s <%s> %s\n" % (
                    datetime.now().strftime("%Y-%m-%d %H:%M:%S"), name, text
                ))
        except Exception as e:
            logger.warning("Could not write chat log: %s", e)

    def broadcast(self):
        n = self.clientCount()
        for c in self.clients:
            c.write_clients(n)
            c.write_busy_sdrs()

    def addClient(self, client):
        pm = Config.get()
        if self.isBanned(client.conn.handler):
            raise BannedClientException()
        elif self.clientCount() >= pm["max_clients"]:
            raise TooManyClientsException()
        elif self.ipCount(client) >= pm["max_clients_per_ip"]:
            raise TooManyClientsException()
        self.clients.append(client)
        self.broadcast()
        self.reportClient(client, { "state":"Connected" })
        self.reportClientActivity(client, "connect")

    def clientCount(self):
        return len(self.clients)

    def ipCount(self, client):
        ip = self.getIp(client.conn.handler)
        return len([x for x in self.clients if ip == self.getIp(x.conn.handler)])

    def robotScore(self, client):
        ip = self.getIp(client.conn.handler)
        return sum([
            max(0, 10 - (client.conn.startTime - x.conn.startTime).total_seconds())
            for x in self.clients
            if ip == self.getIp(x.conn.handler)
        ])

    def removeClient(self, client):
        self.reportClientActivity(client, "disconnect")
        try:
            if client in self.chat:
                del self.chat[client]
            self.clients.remove(client)
        except ValueError:
            pass
        self.broadcast()
        self.reportClient(client, { "state":"Disconnected" })

    def _checkClientCount(self, new_count):
        for client in self.clients[new_count:]:
            logger.debug("closing one connection...")
            client.close()

    # Report client events
    def reportClient(self, client, data):
        pm = Config.get()
        if pm["report_clients"]:
            from owrx.reporting import ReportingEngine
            data.update({
                "mode"      : "CLIENT",
                "timestamp" : round(datetime.now().timestamp() * 1000),
                "ip"        : self.getIp(client.conn.handler),
                "banned"    : self.isBanned(client.conn.handler),
                "clients"   : self.clientCount()
            })
            # Include nickname if known
            if client in self.chat:
                data["name"] = self.chat[client]["name"]
            ReportingEngine.getSharedInstance().spot(data)

    # Report client activity (connect, disconnect, profile_change, freq_change)
    def reportClientActivity(self, client, event):
        pm = Config.get()
        if pm["report_clients"]:
            from owrx.reporting import ReportingEngine
            data = {
                "mode": "CLIENT_ACTIVITY",
                "event": event,
                "timestamp": round(datetime.now().timestamp() * 1000),
                "ip": self.getIp(client.conn.handler),
                "username": None,
                "sdr": None,
                "profile": None,
                "freq": None,
                "offset_freq": None,
                "mod": None,
                "clients": self.clientCount()
            }
            if client in self.chat:
                data["username"] = self.chat[client]["name"]
            if hasattr(client, "sdr") and client.sdr is not None:
                try:
                    data["sdr"] = client.sdr.getName()
                    data["profile"] = client.sdr.getProfileName()
                    data["freq"] = client.sdr.getProps()["center_freq"]
                except Exception:
                    pass
            if hasattr(client, "dsp") and client.dsp:
                try:
                    if client.dsp.chain:
                        data["offset_freq"] = getattr(client.dsp.chain, "frequencyOffset", 0)
                    data["mod"] = client.dsp.props["mod"] if "mod" in client.dsp.props else None
                except Exception:
                    pass
            ReportingEngine.getSharedInstance().spot(data)

    # Report chat message from a client
    def reportChatMessage(self, client, text: str):
        name = self.chat[client]["name"] if client in self.chat else "???"
        self.reportClient(client, {
            "state"   : "ChatMessage",
            "name"    : name,
            "message" : text
        })

    # Generic throwaway names that carry no identity, blocked regardless
    # of length (case-insensitive, checked after the \W cleanup).
    GENERIC_NICKNAMES = {
        "anonym", "anonymous", "gast", "guest", "user", "test", "tester",
        "admin", "unknown", "nobody", "niemand", "keiner", "name",
        "nickname", "rufzeichen", "callsign",
    }

    # Weak-quality nickname rule, mirrored client-side (Chat.js):
    # - at least 4 characters with a digit (every amateur/SWL callsign
    #   qualifies naturally), OR
    # - at least 6 letters for real names without digits ("Seefunker"),
    # - always at least one letter (rejects numeric junk like "12121"),
    # - and never a generic placeholder ("Anonym", "Gast", ...).
    # Enforced server-side so it cannot be bypassed by talking to the
    # WebSocket directly.
    # Placeholder names that dodge the rule above: "RegisteredUser", "user123",
    # "TestUser", "Benutzer1", ... Checked on the letters only, so digits and
    # underscores do not help. Real names ending in "user" (Hauser, Mauser)
    # stay allowed because their prefix is not a generic word.
    PLACEHOLDER_SUBSTRINGS = ("registered", "registriert", "anonym")
    PLACEHOLDER_SUFFIXES = ("benutzer", "nutzer", "user")
    PLACEHOLDER_PREFIXES = {
        "", "new", "neuer", "neue", "guest", "gast", "test", "some", "random",
        "web", "sdr", "radio", "funk", "owrx", "openwebrx", "chat", "unknown",
        "default", "temp", "just", "a", "the", "ein", "der", "die", "normal",
        "normaler", "regular", "simple", "einfacher", "standard", "basic",
    }

    @staticmethod
    def isPlaceholderNickname(name: str) -> bool:
        letters = re.sub(r"[^a-z]", "", name.lower())
        if letters in ClientRegistry.GENERIC_NICKNAMES:
            return True
        if any(s in letters for s in ClientRegistry.PLACEHOLDER_SUBSTRINGS):
            return True
        for suffix in ClientRegistry.PLACEHOLDER_SUFFIXES:
            if letters.endswith(suffix) and letters[:-len(suffix)] in ClientRegistry.PLACEHOLDER_PREFIXES:
                return True
        return False

    @staticmethod
    def isValidNickname(name: str) -> bool:
        if name is None or len(name) < 4:
            return False
        if name.lower() in ClientRegistry.GENERIC_NICKNAMES or ClientRegistry.isPlaceholderNickname(name):
            return False
        # Every real callsign or name contains a letter. Without this check,
        # purely numeric junk like "12121" or "6789" slipped through the
        # digit branch, which was only meant to let short callsigns pass.
        if not any(c.isalpha() for c in name):
            return False
        return any(c.isdigit() for c in name) or len(name) >= 6

    # Register nickname for a client without broadcasting a message
    def registerNickname(self, client, name: str):
        if not name:
            return
        with self.chatLock:
            # Names can only include alphanumerics
            name = re.sub(r"\W+", "", name)[:20]
            if not self.isValidNickname(name):
                logger.info("nickname REJECTED: '%s' (from %s)", name, self.getIp(client.conn.handler))
                return
            logger.info("nickname accepted: '%s' (from %s)", name, self.getIp(client.conn.handler))
            # Cannot have duplicate names
            if client not in self.chat or name != self.chat[client]["name"]:
                for c in self.chat:
                    if name == self.chat[c]["name"]:
                        return  # Name already taken
            # Register or update client
            if client in self.chat:
                curname = self.chat[client]["name"]
                if name != curname:
                    self.chatColors.rename(curname, name)
                    self.chat[client]["name"] = name
            else:
                color = self.chatColors.getColor(name)
                self.chat[client] = { "name": name, "color": color }
                self.chatCount = self.chatCount + 1

    # Broadcast chat message to all connected clients.
    def broadcastChatMessage(self, client, text: str, name: str = None):
        # If chat disabled, ignore messages
        pm = Config.get()
        if not pm["allow_chat"]:
            return
        # Make sure there are no race conditions
        with self.chatLock:
            if name is not None:
                # Names can only include alphanumerics
                name = re.sub(r"\W+", "", name)[:20]
                # Low-quality names are dropped -> existing name or "UserN" fallback
                if not self.isValidNickname(name):
                    logger.info("chat nickname REJECTED: '%s' (from %s)", name, self.getIp(client.conn.handler))
                    name = None
            if name is not None:
                # Cannot have duplicate names
                if client not in self.chat or name != self.chat[client]["name"]:
                    for c in self.chat:
                        if name == self.chat[c]["name"]:
                            name = None
                            break
            # If we have seen this client chatting before...
            if client in self.chat:
                # Rename existing client as needed, keep color
                curname = self.chat[client]["name"]
                color   = self.chat[client]["color"]
                if not name or name == curname:
                    name = curname
                else:
                    self.chatColors.rename(curname, name)
                    self.chat[client]["name"] = name
            else:
                # Create name and color for a new client
                name  = "User%d" % self.chatCount if not name else name
                color = self.chatColors.getColor(name)
                self.chat[client] = { "name": name, "color": color }
                self.chatCount = self.chatCount + 1

        self._appendChatHistory(name, text, color)

        # Broadcast message to all clients
        for c in self.clients:
            c.write_chat_message(name, text, color)

        # Report message
        self.reportChatMessage(client, text)

    # Store a chat message in the history (ring buffer), persist it and
    # append it to the unlimited text log
    def _appendChatHistory(self, name: str, text: str, color: str):
        import time
        with self.chatLock:
            self.chatHistory.append({
                "name": name,
                "text": text,
                "color": color,
                "timestamp": int(time.time() * 1000)
            })
            # Ring-Buffer: älteste Nachrichten entfernen wenn voll
            if len(self.chatHistory) > self.chatHistoryMax:
                self.chatHistory = self.chatHistory[-self.chatHistoryMax:]
            self._saveChatHistory()
        self._appendChatLog(name, text)

    # Relay external chat message to all connected clients.
    # Relayed messages (e.g. from the other receiver via MQTT) go into the
    # history too, otherwise only the local half of a conversation survives.
    def relayChatMessage(self, name: str, text: str):
        self._appendChatHistory(name, text, "#ccc")
        for c in self.clients:
            c.write_chat_message(name, text, "#ccc")

    # Get chat history for new clients.
    def getChatHistory(self):
        with self.chatLock:
            return list(self.chatHistory)

    # Broadcast administrative message to all connected clients.
    def broadcastAdminMessage(self, text: str):
        for c in self.clients:
            c.write_log_message(text)

    # Broadcast DX cluster spot to all connected clients.
    def broadcastDxSpot(self, spot):
        for c in self.clients:
            try:
                c.write_dxspots([spot])
            except:
                pass

    # Broadcast generic message to all connected clients.
    def broadcastMessage(self, msg):
        for c in self.clients:
            try:
                c.send(msg)
            except:
                pass

    # Get client IP address from the handler.
    def getIp(self, handler):
        trusted = CoreConfig().get_web_trusted_proxies()
        ip = handler.client_address[0]
        # Parse X-Forwarded-For header when incoming connection is
        # from a local address, loopback, or a trusted proxy
        ip_obj = ip_address(ip)
        if ip_obj.is_private or ip_obj.is_loopback or (trusted is not None and ip in trusted):
            if hasattr(handler, "headers") and "x-forwarded-for" in handler.headers:
                ip = handler.headers['x-forwarded-for'].split(',')[0]
        # Done
        return ip

    # Check if the client behind given handler is exempt from the session
    # timeout ("timeout_exempt_ips" setting: comma-separated IPs or CIDRs).
    # Used for both the web page (meta refresh) and the websocket.
    def isTimeoutExempt(self, handler):
        try:
            pm = Config.get()
            exempt = pm["timeout_exempt_ips"] if "timeout_exempt_ips" in pm else ""
            if not exempt:
                return False
            addr = ip_address(self.getIp(handler).strip())
        except ValueError:
            # Garbage in a client-supplied X-Forwarded-For header
            return False
        except Exception as e:
            logger.warning("Cannot check session timeout exemption: %s", e)
            return False
        for entry in exempt.split(","):
            entry = entry.strip()
            if not entry:
                continue
            try:
                if addr in ip_network(entry, strict=False):
                    return True
            except ValueError:
                logger.warning("Invalid IP/CIDR in timeout_exempt_ips: %s", entry)
        return False

    # List all active and banned clients.
    def listAll(self):
        result = []
        # List active clients
        for c in self.clients:
            entry = {
                "ts"   : c.conn.startTime,
                "ip"   : self.getIp(c.conn.handler),
                "ban"  : False
            }
            if c.sdr is not None:
                entry["sdr"]  = c.sdr.getName()
                entry["band"] = c.sdr.getProfileName()
            if c in self.chat:
                entry["name"] = self.chat[c]["name"]
            result.append(entry)
        # Flush out stale bans
        self.expireBans()
        # List banned clients
        for ip, ban in self.bans.items():
            result.append({
                "ts"     : ban["until"],   # None = permanent
                "ip"     : ip,
                "ban"    : True,
                "tokens" : len(ban["tokens"])
            })
        # Done
        return result

    # --- Bans: by IP and by per-browser cookie token, persisted in BANS_FILE ---

    @staticmethod
    def getToken(handler):
        """Per-browser client token from the cookie, or None if absent/invalid."""
        try:
            if hasattr(handler, "headers"):
                cookies = SimpleCookie(handler.headers.get("Cookie", ""))
                if CLIENT_TOKEN_COOKIE in cookies:
                    token = cookies[CLIENT_TOKEN_COOKIE].value
                    if re.fullmatch(r"[0-9a-f]{32}", token):
                        return token
        except Exception:
            pass
        return None

    @staticmethod
    def _parseBans(data):
        bans = {}
        for ip, entry in data.items():
            until = entry.get("until")
            bans[ip] = {
                "until": datetime.fromisoformat(until) if until else None,
                "tokens": [t for t in entry.get("tokens", []) if isinstance(t, str)],
            }
        return bans

    @staticmethod
    def _serializeBans(bans):
        return {
            ip: {"until": b["until"].isoformat() if b["until"] else None, "tokens": b["tokens"]}
            for ip, b in bans.items()
        }

    def _loadBans(self):
        try:
            if os.path.exists(BANS_FILE):
                with open(BANS_FILE, "r") as f:
                    bans = self._parseBans(json.load(f))
                logger.info("Loaded %d bans from disk", len(bans))
                return bans
        except Exception as e:
            logger.error("Failed to load bans from %s: %s", BANS_FILE, e)
        return {}

    def _saveBans(self):
        try:
            tmp = BANS_FILE + ".tmp"
            with open(tmp, "w") as f:
                json.dump(self._serializeBans(self.bans), f, indent=2)
            os.replace(tmp, BANS_FILE)
        except Exception as e:
            logger.error("Failed to save bans to %s: %s", BANS_FILE, e)

    # Ban a client for given number of minutes (0 = permanent).
    def banClient(self, client, minutes: int):
        self.banIp(self.getIp(client.conn.handler), minutes, self.getToken(client.conn.handler))

    # Ban an IP for given number of minutes (0 = permanent). Cookie tokens
    # of clients currently connected from that IP are recorded too, so the
    # ban sticks to the browser even when the address changes.
    def banIp(self, ip: str, minutes: int, token: str = None):
        self.expireBans()
        ban = self.bans.get(ip, {"until": None, "tokens": []})
        ban["until"] = None if minutes <= 0 else datetime.now() + timedelta(minutes=minutes)
        banned = []
        for c in self.clients:
            if ip == self.getIp(c.conn.handler):
                banned.append(c)
                t = self.getToken(c.conn.handler)
                if t and t not in ban["tokens"]:
                    ban["tokens"].append(t)
        if token and token not in ban["tokens"]:
            ban["tokens"].append(token)
        self.bans[ip] = ban
        self._saveBans()
        for c in banned:
            try:
                c.close()
            except:
                logger.exception("exception while banning %s" % ip)

    # Unban a client, by IP (drops the attached tokens as well).
    def unbanIp(self, ip: str):
        if ip in self.bans:
            del self.bans[ip]
            self._saveBans()

    # Check if the connecting client is banned, by IP or by cookie token.
    # A token seen from a banned IP gets attached to that ban (sticky).
    def isBanned(self, handler):
        self.expireBans()
        ip = self.getIp(handler)
        token = self.getToken(handler)
        if ip in self.bans:
            if token and token not in self.bans[ip]["tokens"]:
                self.bans[ip]["tokens"].append(token)
                self._saveBans()
                logger.info("ban on %s now also covers client token %s...", ip, token[:8])
            return True
        if token:
            for bip, ban in self.bans.items():
                if token in ban["tokens"]:
                    logger.info("client token %s... from %s matches ban on %s", token[:8], ip, bip)
                    return True
        return False

    # Delete all expired bans (permanent bans have until=None).
    def expireBans(self):
        now = datetime.now()
        old = [ip for ip, b in self.bans.items() if b["until"] is not None and now >= b["until"]]
        for ip in old:
            del self.bans[ip]
        if old:
            self._saveBans()
