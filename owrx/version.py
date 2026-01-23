from distutils.version import LooseVersion

# Base version from upstream OpenWebRX+
_upstream_version = "1.2.105"
# Fork identifier
_fork_suffix = "-DG7LAN"

_versionstring = _upstream_version
looseversion = LooseVersion(_versionstring)
openwebrx_version = "v{0}{1}".format(looseversion, _fork_suffix)
