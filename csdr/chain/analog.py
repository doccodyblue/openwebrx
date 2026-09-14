from csdr.chain.demodulator import BaseDemodulatorChain, FixedIfSampleRateChain, HdAudio, \
    FixedAudioRateChain, DeemphasisTauChain, MetaProvider, RdsChain, PreAgcNotchChain
from pycsdr.modules import AmDemod, DcBlock, FmDemod, Limit, NfmDeemphasis, Agc, Afc, \
    WfmDeemphasis, FractionalDecimator, RealPart, Writer, Buffer
from pycsdr.types import Format, AgcProfile
from csdr.chain.toolbox import RdsDemodulator
from typing import Optional
from owrx.feature import FeatureDetector


# DG7LAN: AGC-Profile nachschärfen. Die Attack-Raten aus pycsdr/types.py
# (0.005 Slow … 0.01 Fast, pro Sample) sind bei 12 kHz Audio viel zu träge:
# 20 dB wegregeln dauert 19–38 ms, der 100-Sample-Lookahead (8 ms) der csdr-AGC
# fängt davon nur 4–9 dB ab -> hörbares Clipping bei jedem lauten Einsatz, auch
# im Profil "Slow". Attack 0.1 (= csdr-C++-Default) regelt 20 dB in <2 ms weg,
# komplett innerhalb des Lookaheads. Decay und Hang-Time bleiben profilabhängig,
# "Slow" bleibt also slow. Der Override sitzt hier statt in pycsdr/types.py,
# damit ihn ein pycsdr-Rebuild (buildall.sh / dpkg -i) nicht wieder frisst —
# genau so ging der types.py-Patch vom 2026-05-15 am 2026-08-06 verloren.
_AGC_TUNING = {
    #                 attack  decay    hangTime (Samples)
    AgcProfile.SLOW: (0.1,    0.0001,  600),
    AgcProfile.LAG:  (0.1,    0.00025, 550),
    AgcProfile.MID:  (0.1,    0.00045, 300),
    AgcProfile.FAST: (0.1,    0.001,   200),
}
for _profile, (_attack, _decay, _hang) in _AGC_TUNING.items():
    _profile.attack, _profile.decay, _profile.hangTime = _attack, _decay, _hang


class Am(BaseDemodulatorChain, PreAgcNotchChain):
    def __init__(self, agcProfile: AgcProfile = AgcProfile.SLOW):
        agc = Agc(Format.FLOAT)
        agc.setProfile(agcProfile)
        agc.setInitialGain(200)
        workers = [
            AmDemod(),
            DcBlock(),
            agc,
        ]
        super().__init__(workers)


class NFm(BaseDemodulatorChain):
    def __init__(self, sampleRate: int, agcProfile: AgcProfile = AgcProfile.SLOW):
        self.sampleRate = sampleRate
        agc = Agc(Format.FLOAT)
        agc.setProfile(agcProfile)
        agc.setMaxGain(3)
        workers = [
            FmDemod(),
            Limit(),
            NfmDeemphasis(sampleRate),
            agc,
        ]
        super().__init__(workers)

    def setSampleRate(self, sampleRate: int) -> None:
        if sampleRate == self.sampleRate:
            return
        self.sampleRate = sampleRate
        self.replace(2, NfmDeemphasis(sampleRate))


class WFm(BaseDemodulatorChain, FixedIfSampleRateChain, DeemphasisTauChain, HdAudio, MetaProvider, RdsChain):
    def __init__(self, sampleRate: int, tau: float, rdsRbds: bool):
        self.sampleRate = sampleRate
        self.tau = tau
        self.rdsRbds = rdsRbds
        self.limit = Limit()
        # this buffer is used to tap into the raw audio stream for redsea RDS decoding
        self.metaTapBuffer = Buffer(Format.FLOAT)
        workers = [
            FmDemod(),
            self.limit,
            FractionalDecimator(Format.FLOAT, 200000.0 / self.sampleRate, prefilter=True),
            WfmDeemphasis(self.sampleRate, self.tau),
        ]
        self.metaChain = None
        self.metaWriter = None
        super().__init__(workers)

    def _connect(self, w1, w2, buffer: Optional[Buffer] = None) -> None:
        if w1 is self.limit:
            buffer = self.metaTapBuffer
        super()._connect(w1, w2, buffer)

    def getFixedIfSampleRate(self):
        return 200000

    def setDeemphasisTau(self, tau: float) -> None:
        if tau == self.tau:
            return
        self.tau = tau
        self.replace(3, WfmDeemphasis(self.sampleRate, self.tau))

    def setSampleRate(self, sampleRate: int) -> None:
        if sampleRate == self.sampleRate:
            return
        self.sampleRate = sampleRate
        self.replace(2, FractionalDecimator(Format.FLOAT, 200000.0 / self.sampleRate, prefilter=True))
        self.replace(3, WfmDeemphasis(self.sampleRate, self.tau))

    def setMetaWriter(self, writer: Writer) -> None:
        if not FeatureDetector().is_available("rds"):
            return
        if self.metaChain is None:
            self.metaChain = RdsDemodulator(self.getFixedIfSampleRate(), self.rdsRbds)
            self.metaChain.setReader(self.metaTapBuffer.getReader())
        self.metaWriter = writer
        self.metaChain.setWriter(self.metaWriter)

    def stop(self):
        super().stop()
        if self.metaChain is not None:
            self.metaChain.stop()
            self.metaChain = None
            self.metaWriter = None

    def setRdsRbds(self, rdsRbds: bool) -> None:
        self.rdsRbds = rdsRbds
        if self.metaChain is not None:
            self.metaChain.stop()
            self.metaChain = RdsDemodulator(self.getFixedIfSampleRate(), self.rdsRbds)
            self.metaChain.setReader(self.metaTapBuffer.getReader())
            self.metaChain.setWriter(self.metaWriter)


class Ssb(BaseDemodulatorChain, PreAgcNotchChain):
    def __init__(self, agcProfile: AgcProfile = AgcProfile.FAST):
        agc = Agc(Format.FLOAT)
        agc.setProfile(agcProfile)
        workers = [
            RealPart(),
            agc,
        ]
        super().__init__(workers)


class Empty(BaseDemodulatorChain):
    def __init__(self):
        super().__init__([])

    def getOutputFormat(self) -> Format:
        return Format.FLOAT

    def setWriter(self, writer):
        pass


class SAm(BaseDemodulatorChain, PreAgcNotchChain):
    def __init__(self, sampleRate: int, agcProfile: AgcProfile = AgcProfile.SLOW):
        agc = Agc(Format.FLOAT)
        agc.setProfile(agcProfile)
        agc.setInitialGain(200)
        workers = [
            Afc(sampleRate),
            RealPart(),
            DcBlock(),
            agc,
        ]
        super().__init__(workers)


class SsbDigital(BaseDemodulatorChain, FixedAudioRateChain, HdAudio):
    def __init__(self, sampleRate: int = 48000):
        self.sampleRate = sampleRate
        workers = [
            RealPart(),
            Agc(Format.FLOAT),
        ]
        super().__init__(workers)

    def getFixedAudioRate(self) -> int:
        return self.sampleRate
