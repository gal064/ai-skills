"""Stops the browser-use daemon enabling the CDP Runtime domain on every tab.

With Runtime enabled, Chrome serializes console arguments for the debugger,
which pages can observe; bot detectors report it as isAutomatedWithCDP.
Runtime.evaluate works without it, and nothing in the daemon reads Runtime
events. The daemon hardcodes its domain list, so bu puts this directory on
PYTHONPATH to filter the call instead.

Patching cdp_use rather than the daemon is deliberate: the daemon runs as
__main__, so importing browser_harness.daemon here would patch a second copy.
"""

import sys

if "browser_harness.daemon" in getattr(sys, "orig_argv", ()):
    from cdp_use.client import CDPClient

    send_raw = CDPClient.send_raw

    async def send_raw_without_default_runtime(self, method, params=None, session_id=None):
        # The daemon's automatic enable sends no params. A deliberate
        # cdp("Runtime.enable") arrives with {} and still reaches Chrome.
        if method == "Runtime.enable" and params is None:
            return {}
        return await send_raw(self, method, params, session_id)

    CDPClient.send_raw = send_raw_without_default_runtime
