// NR2 Noise Reduction - WDSP-style with OSMS, Gain Methods, and AE Filter
// Based on WDSP library by Warren Pratt (NR0V) and Martin (2001) OSMS paper

class NR2Processor extends AudioWorkletProcessor {
    constructor() {
        super();

        this.fftSize = 512;
        this.hopSize = 128;
        this.enabled = false;
        this.amount = 0;
        this.profile = 'easy';  // 'easy' or 'dx'

        // New WDSP-style parameters
        this.npeMethod = 'osms';      // 'osms' or 'simple'
        this.gainMethod = 'gamma';    // 'linear', 'log', 'gamma'
        this.aeEnabled = false;       // Artifact Elimination filter
        this.t1 = -0.5;               // OSMS time constant 1 (-2.0 to +2.0)
        this.t2 = 0.2;                // OSMS time constant 2 (0.0 to 1.0)
        this.gateDepth = 0.5;         // Gate depth 0.0 (off) to 1.0 (full)

        // Buffers
        this.inputRing = new Float32Array(this.fftSize * 2);
        this.outputRing = new Float32Array(this.fftSize * 2);
        this.writeIdx = 0;
        this.readIdx = 0;
        this.samplesIn = 0;

        // FFT
        this.real = new Float32Array(this.fftSize);
        this.imag = new Float32Array(this.fftSize);

        // Hann window
        this.window = new Float32Array(this.fftSize);
        for (let i = 0; i < this.fftSize; i++) {
            this.window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / this.fftSize));
        }

        this.numBins = this.fftSize / 2 + 1;

        // ========================================
        // OSMS Noise Estimation (Martin 2001)
        // ========================================
        // Parameters for HF audio (8-12kHz bandwidth at 48kHz sample rate)
        this.osmsAlpha = 0.96;        // Smoothing factor (~50ms at 48kHz/128 hop)
        this.osmsD = 8;               // Number of subwindows
        this.osmsV = 15;              // Frames per subwindow (~400ms total)
        this.osmsBmin = 2.0;          // Bias compensation factor

        // Smoothed power spectrum P(k)
        this.smoothedPower = new Float32Array(this.numBins);
        this.smoothedPower.fill(0.0001);

        // Subwindow minimum tracking - D subwindows per bin
        // Each subwindow stores the minimum seen in that window
        this.subwindowMins = [];
        for (let k = 0; k < this.numBins; k++) {
            this.subwindowMins[k] = new Float32Array(this.osmsD);
            this.subwindowMins[k].fill(1e10);
        }
        this.subwindowIdx = 0;        // Current subwindow index
        this.subwindowFrame = 0;      // Frame counter within subwindow

        // Final noise power estimate
        this.noisePower = new Float32Array(this.numBins);
        this.noisePower.fill(0.0001);

        // Signal power for legacy simple mode
        this.signalPower = new Float32Array(this.numBins);
        this.signalPower.fill(0.0001);

        // For simple minimum tracking (legacy fallback)
        this.minTrack = new Float32Array(this.numBins);
        this.minTrack.fill(1e10);

        // Gain smoothing (temporal)
        this.prevGain = new Float32Array(this.numBins);
        this.prevGain.fill(1.0);

        // AE Filter: frequency-smoothed gains
        this.freqSmoothedGain = new Float32Array(this.numBins);
        this.freqSmoothedGain.fill(1.0);

        // VAD-based Soft Gate using Spectral Flatness
        this.gateGain = 1.0;           // Current gate gain (0-1)
        this.gateOpen = true;          // Gate state - start open
        this.holdCounter = 0;          // Hold time counter
        this.spectralFlatness = 1.0;   // Current spectral flatness (0=peaky/voice, 1=flat/noise)
        this.smoothedFlatness = 0.5;   // Smoothed flatness for decisions
        // Timing @ 48kHz
        this.gateAttack = 0.00008;     // Slow attack (~250ms rise time)
        this.gateRelease = 0.0001;     // Very slow release (~2s) for soft fade
        this.holdTime = 19200;         // ~400ms hold before fade starts
        // Crest threshold: below = voice, above = noise
        // Based on tests: noise ~0.4, voice ~0.2-0.3
        this.flatnessThreshold = 0.35;

        this.frameCount = 0;
        this.initFFT();

        this.port.start();
        this.port.onmessage = (e) => {
            if (e.data.enabled !== undefined) this.enabled = e.data.enabled;
            if (e.data.strength !== undefined) {
                this.amount = Math.min(1, e.data.strength / 2);
            }
            if (e.data.reset) {
                this.resetState();
            }
            if (e.data.profile !== undefined) {
                this.profile = e.data.profile;
            }
            // New WDSP-style parameters
            if (e.data.npeMethod !== undefined) {
                this.npeMethod = e.data.npeMethod;
            }
            if (e.data.gainMethod !== undefined) {
                this.gainMethod = e.data.gainMethod;
            }
            if (e.data.aeEnabled !== undefined) {
                this.aeEnabled = e.data.aeEnabled;
            }
            if (e.data.t1 !== undefined) {
                this.t1 = e.data.t1;
                // Update OSMS alpha based on T1
                // T1 controls smoothing: -2 = fast (less smoothing), +2 = slow (more smoothing)
                // T1 range: -2 to +2 -> alpha range: 0.90 to 0.98
                this.osmsAlpha = 0.90 + 0.02 * (this.t1 + 2);  // 0.90 to 0.98
                this.osmsAlpha = Math.min(0.99, Math.max(0.80, this.osmsAlpha));  // Safety clamp
                // Reset OSMS state to prevent "stuck" noise estimate
                this.resetOSMS();
            }
            if (e.data.t2 !== undefined) {
                this.t2 = e.data.t2;
                // T2 controls bias compensation
                // Lower T2 = more aggressive (lower noise floor), higher = more conservative
                this.osmsBmin = 1.5 + this.t2 * 2.0;  // 1.5 to 3.5
            }
            if (e.data.gateDepth !== undefined) {
                this.gateDepth = Math.max(0.0, Math.min(1.0, e.data.gateDepth));
            }
        };
    }

    resetState() {
        this.noisePower.fill(0.0001);
        this.signalPower.fill(0.0001);
        this.smoothedPower.fill(0.0001);
        this.minTrack.fill(1e10);
        this.prevGain.fill(1.0);
        this.freqSmoothedGain.fill(1.0);
        this.gateGain = 1.0;
        this.spectralFlatness = 1.0;
        this.smoothedFlatness = 0.5;
        this.resetOSMS();
    }

    resetOSMS() {
        // Reset OSMS subwindow state - prevents "stuck" noise estimates
        this.subwindowIdx = 0;
        this.subwindowFrame = 0;
        for (let k = 0; k < this.numBins; k++) {
            // Reset to current smoothed power, not 1e10
            // This allows quick recovery
            const currentPower = this.smoothedPower[k] || 0.0001;
            this.subwindowMins[k].fill(currentPower);
        }
        // Also reset noise power to allow re-estimation
        this.noisePower.fill(0.0001);
    }

    initFFT() {
        this.cos = new Float32Array(this.fftSize / 2);
        this.sin = new Float32Array(this.fftSize / 2);
        for (let i = 0; i < this.fftSize / 2; i++) {
            this.cos[i] = Math.cos(2 * Math.PI * i / this.fftSize);
            this.sin[i] = Math.sin(2 * Math.PI * i / this.fftSize);
        }
    }

    fft(re, im, inv) {
        const n = re.length;
        for (let i = 0, j = 0; i < n - 1; i++) {
            if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
            for (var k = n >> 1; k <= j; j -= k, k >>= 1);
            j += k;
        }
        const dir = inv ? 1 : -1;
        for (let len = 2; len <= n; len <<= 1) {
            const half = len >> 1, step = n / len;
            for (let i = 0; i < n; i += len) {
                for (let k = 0; k < half; k++) {
                    const c = this.cos[k * step], s = dir * this.sin[k * step];
                    const tr = re[i+k+half]*c - im[i+k+half]*s;
                    const ti = re[i+k+half]*s + im[i+k+half]*c;
                    re[i+k+half] = re[i+k] - tr; im[i+k+half] = im[i+k] - ti;
                    re[i+k] += tr; im[i+k] += ti;
                }
            }
        }
        if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }

    // OSMS: Update subwindow minimum tracking
    updateOSMS(k, smoothedPower) {
        // Track minimum within current subwindow
        if (smoothedPower < this.subwindowMins[k][this.subwindowIdx]) {
            this.subwindowMins[k][this.subwindowIdx] = smoothedPower;
        }
    }

    // OSMS: Get noise estimate from subwindow minima
    getOSMSNoiseEstimate(k) {
        // Find minimum across all subwindows
        let minVal = 1e10;
        for (let d = 0; d < this.osmsD; d++) {
            if (this.subwindowMins[k][d] < minVal) {
                minVal = this.subwindowMins[k][d];
            }
        }
        // Apply bias compensation
        return minVal * this.osmsBmin;
    }

    // Calculate gain using selected method
    calculateGain(signalPower, noisePower, gainFloor) {
        const snr = signalPower / (noisePower + 1e-10);
        let gain;

        switch (this.gainMethod) {
            case 'linear':
                // Linear: gain = max(1 - sqrt(noise/signal), floor)
                gain = Math.max(1 - Math.sqrt(1 / snr), gainFloor);
                break;

            case 'log':
                // Log: softer at low SNR, good for weak signals
                // gain = max(1 - log(1 + noise/signal) / log(2), floor)
                gain = Math.max(1 - Math.log(1 + 1 / snr) / Math.log(2), gainFloor);
                break;

            case 'gamma':
            default:
                // Gamma (Wiener-filter style): gamma=2 for power domain
                // gain = (max(1 - (noise/signal)^(gamma/2), 0))^(1/gamma)
                const gamma = 2.0;
                const ratio = Math.pow(1 / snr, gamma / 2);
                gain = Math.pow(Math.max(1 - ratio, 0), 1 / gamma);
                gain = Math.max(gain, gainFloor);
                break;
        }

        return Math.min(gain, 1.0);
    }

    // AE Filter: Smooth gains across frequency bins
    applyAEFilter(gains) {
        if (!this.aeEnabled) return gains;

        const result = new Float32Array(gains.length);

        // Frequency smoothing: 3-tap FIR
        for (let k = 0; k < gains.length; k++) {
            const prev = k > 0 ? gains[k - 1] : gains[k];
            const next = k < gains.length - 1 ? gains[k + 1] : gains[k];
            result[k] = 0.25 * prev + 0.5 * gains[k] + 0.25 * next;
        }

        // Additional temporal smoothing for AE
        for (let k = 0; k < gains.length; k++) {
            // Prevent sudden drops (holes in audio)
            if (result[k] < this.freqSmoothedGain[k] * 0.7) {
                result[k] = this.freqSmoothedGain[k] * 0.85;
            }
            // Update stored smoothed gain
            this.freqSmoothedGain[k] = 0.6 * this.freqSmoothedGain[k] + 0.4 * result[k];
        }

        return result;
    }

    processFrame(start) {
        const N = this.fftSize, N2 = N * 2;
        this.frameCount++;

        // Apply window + FFT
        for (let i = 0; i < N; i++) {
            this.real[i] = this.inputRing[(start + i) % N2] * this.window[i];
            this.imag[i] = 0;
        }
        this.fft(this.real, this.imag, false);

        // Calculate Spectral Crest Factor for VAD
        // Crest = peak / RMS - high for voice (peaks), low for noise (flat)
        // We invert it so: low = voice, high = noise (like flatness)
        let sumSq = 0;
        let maxPower = 0;
        const startBin = 3;  // Skip DC
        const endBin = Math.min(this.numBins, 80);  // Voice range

        for (let k = startBin; k < endBin; k++) {
            const re = this.real[k], im = this.imag[k];
            const power = re * re + im * im;
            sumSq += power;
            if (power > maxPower) maxPower = power;
        }

        const numBinsVAD = endBin - startBin;
        if (numBinsVAD > 0 && sumSq > 0) {
            const rmsPower = Math.sqrt(sumSq / numBinsVAD);
            const peakPower = Math.sqrt(maxPower);
            const crest = peakPower / (rmsPower + 1e-10);
            this.spectralFlatness = Math.max(0, Math.min(1, 1.5 / crest));
        }

        // Parameters based on amount
        const overSub = 1 + this.amount * 4;  // Over-subtraction factor 1-5
        const gainFloor = 0.08 - this.amount * 0.07;  // 0.08 to 0.01
        const gainSmooth = 0.5 + this.amount * 0.3;  // Temporal smoothing

        // Collect gains for potential AE processing
        const gains = new Float32Array(this.numBins);

        for (let k = 0; k < this.numBins; k++) {
            const re = this.real[k], im = this.imag[k];
            const mag = Math.sqrt(re * re + im * im);
            const power = mag * mag;

            let noiseEst;

            if (this.npeMethod === 'osms') {
                // ========================================
                // OSMS Noise Estimation (Martin 2001)
                // ========================================

                // Step 1: Smooth power spectrum
                this.smoothedPower[k] = this.osmsAlpha * this.smoothedPower[k] +
                                        (1 - this.osmsAlpha) * power;
                // Safety: prevent NaN/Infinity from corrupting state
                if (!isFinite(this.smoothedPower[k])) this.smoothedPower[k] = 0.0001;

                // Step 2: Update subwindow minimum tracking
                this.updateOSMS(k, this.smoothedPower[k]);

                // Step 3: Get noise estimate with bias compensation
                noiseEst = this.getOSMSNoiseEstimate(k);

            } else {
                // ========================================
                // Simple Minimum Tracking (legacy)
                // ========================================
                const alpha = 0.98;
                this.signalPower[k] = alpha * this.signalPower[k] + (1 - alpha) * power;

                if (this.signalPower[k] < this.minTrack[k]) {
                    this.minTrack[k] = this.signalPower[k];
                } else {
                    this.minTrack[k] = 0.9999 * this.minTrack[k] + 0.0001 * this.signalPower[k];
                }

                noiseEst = this.minTrack[k] * 2.0;
            }

            // Smooth noise estimate
            const beta = 0.995;
            this.noisePower[k] = beta * this.noisePower[k] + (1 - beta) * noiseEst;

            // Calculate gain using selected method
            const signalPower = power + 1e-10;
            const noisePowerScaled = this.noisePower[k] * overSub;
            let gain = this.calculateGain(signalPower, noisePowerScaled, gainFloor);

            // Temporal smoothing
            gain = gainSmooth * this.prevGain[k] + (1 - gainSmooth) * gain;
            this.prevGain[k] = gain;

            gains[k] = gain;
        }

        // Apply AE Filter if enabled
        const finalGains = this.applyAEFilter(gains);

        // Apply gains to spectrum
        for (let k = 0; k < this.numBins; k++) {
            // Blend dry/wet
            const finalGain = 1.0 - this.amount + this.amount * finalGains[k];

            this.real[k] *= finalGain;
            this.imag[k] *= finalGain;

            if (k > 0 && k < this.numBins - 1) {
                this.real[N - k] = this.real[k];
                this.imag[N - k] = -this.imag[k];
            }
        }

        // OSMS: Advance subwindow frame counter
        this.subwindowFrame++;
        if (this.subwindowFrame >= this.osmsV) {
            this.subwindowFrame = 0;
            // Move to next subwindow
            this.subwindowIdx = (this.subwindowIdx + 1) % this.osmsD;
            // Reset the new subwindow's minima
            for (let k = 0; k < this.numBins; k++) {
                this.subwindowMins[k][this.subwindowIdx] = this.smoothedPower[k];
            }
        }

        // Simple mode: Reset min tracking periodically
        if (this.npeMethod === 'simple' && this.frameCount % 500 === 0) {
            for (let k = 0; k < this.numBins; k++) {
                this.minTrack[k] = this.signalPower[k];
            }
        }

        // Profile-specific EQ
        // At 48kHz/512 FFT: bin = freq / 93.75
        // Bin 1 = ~94Hz, Bin 3 = ~280Hz, Bin 16 = ~1500Hz, Bin 21 = ~2000Hz
        if (this.profile === 'dx') {
            // DX mode: Speech clarity boost 300-2000 Hz (+6dB)
            // Helps understand weak signals
            const eqLowBin = 3;
            const eqHighBin = 21;
            const eqBoost = 2.0;  // +6dB
            for (let k = eqLowBin; k <= eqHighBin && k < this.numBins; k++) {
                this.real[k] *= eqBoost;
                this.imag[k] *= eqBoost;
                if (k > 0 && k < this.numBins - 1) {
                    this.real[N - k] *= eqBoost;
                    this.imag[N - k] *= eqBoost;
                }
            }
        } else {
            // Easy mode: Warm, smooth sound for relaxed listening
            // Slight bass boost ~80-200Hz (+3dB)
            // Slight cut in harsh range 1.5-2kHz (-2dB)
            for (let k = 1; k < this.numBins; k++) {
                let eqGain = 1.0;
                if (k <= 2) {
                    // Bass boost: bins 1-2 (~94-188Hz)
                    eqGain = 1.4;  // +3dB
                } else if (k >= 16 && k <= 21) {
                    // Cut harsh range: bins 16-21 (~1.5-2kHz)
                    eqGain = 0.8;  // -2dB
                } else if (k >= 3 && k <= 8) {
                    // Slight warmth: bins 3-8 (~280-750Hz)
                    eqGain = 1.15;  // +1.2dB
                }
                if (eqGain !== 1.0) {
                    this.real[k] *= eqGain;
                    this.imag[k] *= eqGain;
                    if (k > 0 && k < this.numBins - 1) {
                        this.real[N - k] *= eqGain;
                        this.imag[N - k] *= eqGain;
                    }
                }
            }
        }

        this.fft(this.real, this.imag, true);

        const scale = this.hopSize / this.fftSize * 2;
        for (let i = 0; i < N; i++) {
            this.outputRing[(start + i) % N2] += this.real[i] * scale;
        }
    }

    process(inputs, outputs) {
        const inp = inputs[0]?.[0];
        const out = outputs[0]?.[0];
        if (!inp || !out) return true;

        const N = this.fftSize, N2 = N * 2, hop = this.hopSize;

        // Process frames for NR (this also calculates spectralFlatness)
        for (let i = 0; i < inp.length; i++) {
            this.inputRing[this.writeIdx] = inp[i];
            this.writeIdx = (this.writeIdx + 1) % N2;
            this.samplesIn++;

            if (this.samplesIn >= N && (this.samplesIn - N) % hop === 0) {
                this.processFrame((this.writeIdx - N + N2) % N2);
            }
        }

        // Smooth spectral flatness (fast attack when voice detected, slow release)
        if (this.spectralFlatness < this.smoothedFlatness) {
            // Voice detected - respond quickly
            this.smoothedFlatness = 0.7 * this.smoothedFlatness + 0.3 * this.spectralFlatness;
        } else {
            // Noise - respond slowly
            this.smoothedFlatness = 0.98 * this.smoothedFlatness + 0.02 * this.spectralFlatness;
        }

        // Profile-specific parameters
        // Easy: relaxed listening, keep some background, slow gate, voice EQ
        // DX: aggressive, faster gate, more attenuation, no EQ boost
        let holdTime, gateRelease, minGainBase, minGainRange;
        if (this.profile === 'dx') {
            holdTime = 7200;           // ~150ms hold (faster)
            gateRelease = 0.0003;      // ~0.3s release (faster)
            minGainBase = 0.15;        // More aggressive gate
            minGainRange = 0.10;       // 0.15 to 0.05
        } else {
            // 'easy' profile (default)
            holdTime = 19200;          // ~400ms hold
            gateRelease = 0.0001;      // ~2s release (slow fade)
            minGainBase = 0.40;        // Keep some noise
            minGainRange = 0.20;       // 0.40 to 0.20
        }

        // VAD decision based on spectral crest
        // Low value = voice (peaky spectrum), high value = noise (flat spectrum)
        const dynamicThreshold = this.flatnessThreshold - this.amount * 0.05;  // 0.35 to 0.30
        const voiceDetected = this.smoothedFlatness < dynamicThreshold;

        if (voiceDetected) {
            this.gateOpen = true;
            this.holdCounter = holdTime;
        } else if (this.holdCounter > 0) {
            this.holdCounter -= inp.length;
        } else {
            this.gateOpen = false;
        }

        // Level compensation: +9dB at max NR to compensate for filtered energy loss + gate
        const makeupGain = 1 + this.amount * 1.8;  // 1.0 to 2.8 (+0 to +9dB)

        // VAD gate based on spectral crest factor - depth controlled by gateDepth slider
        // gateDepth: 0.0 = no gate, 1.0 = full gate
        const profileMinGain = minGainBase - this.amount * minGainRange;
        const minGain = 1.0 - this.gateDepth * (1.0 - profileMinGain);  // Interpolate
        const gateTarget = this.gateOpen ? 1.0 : minGain;
        const gateSpeed = this.gateOpen ? this.gateAttack : gateRelease;

        for (let i = 0; i < out.length; i++) {
            // Smooth gate gain transition
            this.gateGain += (gateTarget - this.gateGain) * gateSpeed;

            if (this.samplesIn > N) {
                if (this.enabled) {
                    // Apply NR output with makeup gain and soft gate
                    let sample = this.outputRing[this.readIdx] * makeupGain * this.gateGain;
                    // Soft limiter - only engage when approaching clipping
                    if (sample > 0.9) sample = 0.9 + (sample - 0.9) * 0.3;
                    else if (sample < -0.9) sample = -0.9 + (sample + 0.9) * 0.3;
                    out[i] = sample;
                } else {
                    out[i] = this.inputRing[(this.readIdx + N) % N2];
                }
                this.outputRing[this.readIdx] = 0;
                this.readIdx = (this.readIdx + 1) % N2;
            } else {
                out[i] = inp[i];
            }
        }

        // Report gate reduction to main thread (for S-meter display)
        // Only when enabled and periodically to avoid overhead
        if (this.enabled && this.frameCount % 4 === 0) {
            this.port.postMessage({
                gateReduction: 1.0 - this.gateGain,  // 0 = no reduction, 1 = full reduction
                flatness: this.smoothedFlatness
            });
        }

        return true;
    }
}

registerProcessor('nr2-processor', NR2Processor);
