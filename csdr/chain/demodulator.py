from csdr.chain import Chain
from abc import ABC, ABCMeta, abstractmethod
from pycsdr.modules import Writer, Agc

# AutoNotch is a custom module of our rebuilt pycsdr; guard the import so the
# fork still runs on stock pycsdr, where the pre-AGC notch simply stays off.
try:
    from pycsdr.modules import AutoNotch
    _HAS_AN = True
except ImportError:
    AutoNotch = None
    _HAS_AN = False


class FixedAudioRateChain(ABC):
    @abstractmethod
    def getFixedAudioRate(self) -> int:
        pass


class FixedIfSampleRateChain(ABC):
    @abstractmethod
    def getFixedIfSampleRate(self) -> int:
        pass


class DialFrequencyReceiver(ABC):
    @abstractmethod
    def setDialFrequency(self, frequency: int) -> None:
        pass


# marker interface
class HdAudio:
    pass


class MetaProvider(ABC):
    @abstractmethod
    def setMetaWriter(self, writer: Writer) -> None:
        pass


class SlotFilterChain(ABC):
    @abstractmethod
    def setSlotFilter(self, filter: int) -> None:
        pass


class SecondarySelectorChain(ABC):
    def getBandwidth(self) -> float:
        pass


class DeemphasisTauChain(ABC):
    @abstractmethod
    def setDeemphasisTau(self, tau: float) -> None:
        pass


class RdsChain(ABC):
    @abstractmethod
    def setRdsRbds(self, rdsRbds: bool) -> None:
        pass


class AudioServiceSelector(ABC):
    @abstractmethod
    def setAudioServiceId(self, serviceId: int) -> None:
        pass


class BaseDemodulatorChain(Chain):
    def supportsSquelch(self) -> bool:
        return True

    def setSampleRate(self, sampleRate: int) -> None:
        pass


class PreAgcNotchChain:
    """Mixin for demodulator chains that can host the Auto-Notch *in front of*
    their AGC. Placed there, a carrier or heterodyne is removed before it can
    drive the AGC, so the wanted signal is no longer regulated down along with
    it, and the NLMS predictor sees the natural envelope instead of the AGC's
    fast gain steps. Insertion and removal happen live through the Chain API,
    the same pattern as the Noise Blanker in ClientDemodulatorChain.
    """

    def setPreAgcNotch(self, enabled: bool) -> None:
        if not _HAS_AN:
            return
        index = self.indexOf(lambda x: isinstance(x, AutoNotch))
        if enabled and index < 0:
            agcIndex = self.indexOf(lambda x: isinstance(x, Agc))
            if agcIndex >= 0:
                self.insert(agcIndex, AutoNotch())
        elif not enabled and index >= 0:
            self.remove(index)

    def hasPreAgcNotch(self) -> bool:
        return _HAS_AN and self.indexOf(lambda x: isinstance(x, AutoNotch)) >= 0


class SecondaryDemodulator(Chain):
    def supportsSquelch(self) -> bool:
        return True

    def setSampleRate(self, sampleRate: int) -> None:
        pass

    def isSecondaryFftShown(self):
        return True


class ServiceDemodulator(SecondaryDemodulator, FixedAudioRateChain, metaclass=ABCMeta):
    pass


class DemodulatorError(Exception):
    pass
