from csdr.chain import Chain
from pycsdr.modules import AudioResampler, Convert, AdpcmEncoder, Limit, NoiseFilter
from pycsdr.types import Format

# Custom DSP modules (AutoNotch = LMS notch against carriers/heterodynes,
# RNNoise = neural speech denoiser). Only present in our rebuilt pycsdr;
# guard the imports so the fork still runs on stock pycsdr, where these
# features simply stay unavailable instead of breaking the audio chain.
try:
    from pycsdr.modules import AutoNotch
    _HAS_AN = True
except ImportError:
    AutoNotch = None
    _HAS_AN = False
try:
    from pycsdr.modules import RNNoise
    _HAS_RNN = True
except ImportError:
    RNNoise = None
    _HAS_RNN = False

# RNNoise is trained on 48 kHz speech; other rates get resampled around it
RNNOISE_RATE = 48000


class Converter(Chain):
    def __init__(self, format: Format, inputRate: int, clientRate: int, nrEnabled: bool, nrThreshold: int, anEnabled: bool = False, rnnEnabled: bool = False, rnnMix: int = 100, rnnGate: int = 0):
        anEnabled = anEnabled and _HAS_AN
        rnnEnabled = rnnEnabled and _HAS_RNN
        self.rnn = None
        workers = []
        # we only have an audio resampler and noise filter for float ATM,
        # so if we need to resample or remove noise, we need to convert
        needFloat = inputRate != clientRate or nrEnabled or anEnabled or rnnEnabled
        if needFloat and format != Format.FLOAT:
            workers += [Convert(format, Format.FLOAT)]
        # notch tonal interference first, so the noise reducers downstream
        # don't have to model the carriers
        if anEnabled:
            workers += [AutoNotch()]
        if nrEnabled:
            workers += [NoiseFilter(nrThreshold)]
        if rnnEnabled:
            self.rnn = RNNoise(mix=rnnMix / 100.0, gate=rnnGate / 100.0)
            if inputRate != RNNOISE_RATE:
                workers += [
                    AudioResampler(inputRate, RNNOISE_RATE),
                    self.rnn,
                    AudioResampler(RNNOISE_RATE, inputRate),
                ]
            else:
                workers += [self.rnn]
        if inputRate != clientRate:
            workers += [AudioResampler(inputRate, clientRate), Limit(), Convert(Format.FLOAT, Format.SHORT)]
        elif format != Format.SHORT:
            # Always add Limit() before converting to SHORT to prevent hard clipping
            if format == Format.FLOAT:
                workers += [Limit(), Convert(Format.FLOAT, Format.SHORT)]
            else:
                workers += [Convert(format, Format.SHORT)]
        super().__init__(workers)

    def setRnnMix(self, rnnMix: int) -> None:
        if self.rnn is not None:
            self.rnn.setMix(rnnMix / 100.0)

    def setRnnGate(self, rnnGate: int) -> None:
        if self.rnn is not None:
            self.rnn.setVadGate(rnnGate / 100.0)


class ClientAudioChain(Chain):
    def __init__(self, format: Format, inputRate: int, clientRate: int, compression: str, nrEnabled: bool, nrThreshold: int, anEnabled: bool = False, rnnEnabled: bool = False, rnnMix: int = 100, rnnGate: int = 0):
        self.format = format
        self.inputRate = inputRate
        self.clientRate = clientRate
        self.nrEnabled = nrEnabled
        self.nrThreshold = nrThreshold
        self.anEnabled = anEnabled
        self.rnnEnabled = rnnEnabled
        self.rnnMix = rnnMix
        self.rnnGate = rnnGate
        workers = []
        converter = self._buildConverter()
        if not converter.empty():
            workers += [converter]
        if compression == "adpcm":
            workers += [AdpcmEncoder(sync=True)]
        super().__init__(workers)

    def _buildConverter(self):
        return Converter(self.format, self.inputRate, self.clientRate, self.nrEnabled, self.nrThreshold, self.anEnabled, self.rnnEnabled, self.rnnMix, self.rnnGate)

    def _updateConverter(self):
        converter = self._buildConverter()
        index = self.indexOf(lambda x: isinstance(x, Converter))
        if converter.empty():
            if index >= 0:
                self.remove(index)
        else:
            if index >= 0:
                self.replace(index, converter)
            else:
                self.insert(0, converter)

    def setFormat(self, format: Format) -> None:
        if format == self.format:
            return
        self.format = format
        self._updateConverter()

    def setInputRate(self, inputRate: int) -> None:
        if inputRate == self.inputRate:
            return
        self.inputRate = inputRate
        self._updateConverter()

    def setClientRate(self, clientRate: int) -> None:
        if clientRate == self.clientRate:
            return
        self.clientRate = clientRate
        self._updateConverter()

    def setAudioCompression(self, compression: str) -> None:
        index = self.indexOf(lambda x: isinstance(x, AdpcmEncoder))
        if compression == "adpcm":
            if index < 0:
                self.append(AdpcmEncoder(sync=True))
        else:
            if index >= 0:
                self.remove(index)

    def setNrEnabled(self, nrEnabled: bool) -> None:
        if nrEnabled == self.nrEnabled:
            return
        self.nrEnabled = nrEnabled
        self._updateConverter()

    def setNrThreshold(self, nrThreshold: int) -> None:
        if nrThreshold == self.nrThreshold:
            return
        self.nrThreshold = nrThreshold
        self._updateConverter()

    def setAnEnabled(self, anEnabled: bool) -> None:
        anEnabled = anEnabled and _HAS_AN
        if anEnabled == self.anEnabled:
            return
        self.anEnabled = anEnabled
        self._updateConverter()

    def setRnnEnabled(self, rnnEnabled: bool) -> None:
        rnnEnabled = rnnEnabled and _HAS_RNN
        if rnnEnabled == self.rnnEnabled:
            return
        self.rnnEnabled = rnnEnabled
        self._updateConverter()

    def setRnnMix(self, rnnMix: int) -> None:
        if rnnMix == self.rnnMix:
            return
        self.rnnMix = rnnMix
        # live update on the running RNNoise module, no chain rebuild needed
        index = self.indexOf(lambda x: isinstance(x, Converter))
        if index >= 0:
            self.workers[index].setRnnMix(rnnMix)

    def setRnnGate(self, rnnGate: int) -> None:
        if rnnGate == self.rnnGate:
            return
        self.rnnGate = rnnGate
        # live update, same as the mix
        index = self.indexOf(lambda x: isinstance(x, Converter))
        if index >= 0:
            self.workers[index].setRnnGate(rnnGate)
