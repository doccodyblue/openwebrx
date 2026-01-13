from owrx.controllers import Controller
from owrx.client import ClientRegistry
import json

class ClientsJsonController(Controller):
    """JSON API for active clients - no auth required"""

    def handle_request(self):
        clients = []
        registry = ClientRegistry.getSharedInstance()

        for c in registry.clients:
            entry = {
                "ip": registry.getIp(c.conn.handler),
                "connected_since": int(c.conn.startTime.timestamp() * 1000),
            }

            if c.sdr is not None:
                entry["sdr"] = c.sdr.getName()
                entry["profile"] = c.sdr.getProfileName()

                # Get frequency from SDR props using [] access
                try:
                    props = c.sdr.getProps()
                    entry["center_freq"] = props["center_freq"]
                except:
                    pass
                
                try:
                    props = c.sdr.getProps()
                    entry["samp_rate"] = props["samp_rate"]
                except:
                    pass

            # Get tuned frequency from DSP if available
            if hasattr(c, "dsp") and c.dsp:
                try:
                    if hasattr(c.dsp, "chain") and c.dsp.chain:
                        chain = c.dsp.chain
                        entry["offset_freq"] = getattr(chain, "frequencyOffset", 0)
                        if hasattr(chain, "props"):
                            entry["mod"] = chain.props["mod"] if "mod" in chain.props else ""
                except:
                    pass

            if c in registry.chat:
                entry["name"] = registry.chat[c]["name"]

            clients.append(entry)

        result = {
            "count": len(clients),
            "clients": clients
        }

        self.send_response(json.dumps(result), content_type="application/json")
