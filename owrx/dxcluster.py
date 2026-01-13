"""
DX Cluster Client for OpenWebRX+
"""

import socket
import threading
import re
import logging
import time

logger = logging.getLogger(__name__)

class DXClusterClient:
    _instance = None

    @classmethod
    def getSharedInstance(cls):
        if cls._instance is None:
            cls._instance = DXClusterClient()
        return cls._instance

    @classmethod
    def resetInstance(cls):
        if cls._instance:
            cls._instance.stop()
        cls._instance = None

    def __init__(self):
        self.socket = None
        self.thread = None
        self.running = False
        self.connected = False
        self.spots = []
        self.max_spots = 100

        # Connection params (saved for reconnect)
        self._host = None
        self._port = None
        self._callsign = None
        self._login_script = None

        self.spot_pattern = re.compile(
            r'^DX de ([A-Z0-9/-]+):\s+(\d+\.?\d*)\s+([A-Z0-9/]+)\s*(.*?)\s*(\d{4})Z'
        )

    def parse_spot(self, line):
        match = self.spot_pattern.match(line.strip())
        if match:
            spotter, freq, dx_call, comment, time_str = match.groups()
            return {
                'spotter': spotter.strip(),
                'frequency': int(float(freq) * 1000),
                'dx_call': dx_call.strip(),
                'comment': comment.strip(),
                'time': time_str,
                'timestamp': time.time()
            }
        return None

    def _broadcast_spot(self, spot):
        try:
            from owrx.client import ClientRegistry
            ClientRegistry.getSharedInstance().broadcastDxSpot(spot)
            logger.debug(f"Broadcast spot: {spot['dx_call']}")
        except Exception as e:
            logger.debug(f"Broadcast error: {e}")

    def _broadcast_status(self, connected):
        """Broadcast connection status to all clients"""
        try:
            from owrx.client import ClientRegistry
            ClientRegistry.getSharedInstance().broadcastMessage({
                "type": "dxcluster_status",
                "value": {"connected": connected}
            })
        except Exception as e:
            logger.debug(f"Status broadcast error: {e}")

    def _reader_thread(self):
        """Reader thread with auto-reconnect"""
        reconnect_delay = 5  # Start with 5 seconds
        max_reconnect_delay = 300  # Max 5 minutes

        while self.running:
            buffer = ""
            sock = None

            try:
                # Connect
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.settimeout(30)
                sock.connect((self._host, self._port))
                logger.info(f"Connected to DX cluster {self._host}:{self._port}")

                # Login
                time.sleep(0.5)
                sock.recv(1024)
                sock.send(f"{self._callsign}\r\n".encode())
                time.sleep(1)
                sock.recv(4096)
                logger.info(f"Logged in as {self._callsign}")

                # Execute login script if provided
                if self._login_script:
                    for cmd in self._login_script.strip().split('\n'):
                        cmd = cmd.strip()
                        if cmd:
                            logger.info(f"Sending command: {cmd}")
                            sock.send(f"{cmd}\r\n".encode())
                            time.sleep(0.5)
                            try:
                                sock.settimeout(2)
                                sock.recv(4096)
                            except socket.timeout:
                                pass

                # Mark as connected and broadcast status
                self.connected = True
                self._broadcast_status(True)
                reconnect_delay = 5  # Reset delay on successful connection

                # Read loop
                while self.running:
                    try:
                        sock.settimeout(60)
                        data = sock.recv(4096)
                        if not data:
                            logger.warning("Connection closed by server")
                            break

                        buffer += data.decode('utf-8', errors='replace')

                        while '\n' in buffer:
                            line, buffer = buffer.split('\n', 1)
                            line = line.strip()
                            if line.startswith('DX de '):
                                spot = self.parse_spot(line)
                                if spot:
                                    self.spots.append(spot)
                                    if len(self.spots) > self.max_spots:
                                        self.spots = self.spots[-self.max_spots:]
                                    logger.info(f"DX Spot: {spot['dx_call']} on {spot['frequency']/1000:.1f} kHz (by {spot['spotter']})")
                                    self._broadcast_spot(spot)
                    except socket.timeout:
                        continue

            except Exception as e:
                logger.error(f"DX Cluster error: {e}")
            finally:
                # Mark as disconnected
                self.connected = False
                self._broadcast_status(False)

                if sock:
                    try:
                        sock.send(b"bye\r\n")
                        sock.close()
                    except:
                        pass

            # Auto-reconnect with exponential backoff
            if self.running:
                logger.info(f"DX Cluster reconnecting in {reconnect_delay} seconds...")
                time.sleep(reconnect_delay)
                reconnect_delay = min(reconnect_delay * 2, max_reconnect_delay)

        logger.info("DX Cluster thread ended")

    def start(self, host, port, callsign, login_script=None):
        """Start the DX cluster client"""
        self.stop()  # Ensure clean state

        # Save connection params for reconnect
        self._host = host
        self._port = port
        self._callsign = callsign
        self._login_script = login_script

        self.running = True
        self.spots = []
        self.thread = threading.Thread(
            target=self._reader_thread,
            daemon=True,
            name="DXCluster"
        )
        self.thread.start()
        logger.info(f"DX Cluster starting: {host}:{port} as {callsign}")
        return True

    def stop(self):
        """Stop the DX cluster client"""
        self.running = False
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=5)
        self.thread = None
        self.connected = False
        logger.info("DX Cluster stopped")

    def is_running(self):
        return self.running and self.thread and self.thread.is_alive()

    def is_connected(self):
        return self.connected

    def get_spots(self):
        return self.spots.copy()
