// NR2 Noise Reduction - Spectral Subtraction with Soft Gate

class NR2Processor extends AudioWorkletProcessor {
    constructor() {
        super();

        this.fftSize = 512;
        this.hopSize = 128;
        this.enabled = false;
        this.amount = 0;

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

        // Noise estimation - longer averaging
        this.noisePower = new Float32Array(this.numBins);
        this.noisePower.fill(0.0001);
        this.signalPower = new Float32Array(this.numBins);
        this.signalPower.fill(0.0001);

        // For minimum tracking
        this.minTrack = new Float32Array(this.numBins);
        this.minTrack.fill(1e10);

        // Gain smoothing
        this.prevGain = new Float32Array(this.numBins);
        this.prevGain.fill(1.0);

        // VAD-based Soft Gate using Spectral Flatness
        this.gateGain = 1.0;           // Current gate gain (0-1)
        this.gateOpen = true;          // Gate state - start open
        this.holdCounter = 0;          // Hold time counter
        this.spectralFlatness = 1.0;   // Current spectral flatness (0=peaky/voice, 1=flat/noise)
        this.smoothedFlatness = 0.5;   // Smoothed flatness for decisions
        // Timing @ 48kHz
        this.gateAttack = 0.02;        // Gentler attack (less clicky)
        this.gateRelease = 0.001;      // Slower release (~400ms)
        this.holdTime = 8000;          // ~170ms hold
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
                this.noisePower.fill(0.0001);
                this.signalPower.fill(0.0001);
                this.minTrack.fill(1e10);
                this.prevGain.fill(1.0);
                this.gateGain = 1.0;
                this.spectralFlatness = 1.0;
                this.smoothedFlatness = 0.5;
            }
        };
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

        const numBins = endBin - startBin;
        if (numBins > 0 && sumSq > 0) {
            const rmsPower = Math.sqrt(sumSq / numBins);
            const peakPower = Math.sqrt(maxPower);
            // Crest factor: peak/rms, typically 1-10 for audio
            // Noise: low crest (~1-2), Voice: high crest (~3-8)
            // Invert and normalize: 1/crest, so noise=high, voice=low
            const crest = peakPower / (rmsPower + 1e-10);
            // Map crest 1-6 to flatness 1-0
            this.spectralFlatness = Math.max(0, Math.min(1, 1.5 / crest));
        }

        // Parameters based on amount
        const alpha = 0.98;  // Signal smoothing
        const beta = 0.995;  // Noise smoothing (slow)
        const overSub = 1 + this.amount * 4;  // Over-subtraction factor 1-5
        const gainFloor = 0.08 - this.amount * 0.07;  // 0.08 to 0.01
        const gainSmooth = 0.5 + this.amount * 0.3;  // Temporal smoothing

        for (let k = 0; k < this.numBins; k++) {
            const re = this.real[k], im = this.imag[k];
            const mag = Math.sqrt(re * re + im * im);
            const power = mag * mag;
            
            // Smooth signal power
            this.signalPower[k] = alpha * this.signalPower[k] + (1 - alpha) * power;
            
            // Track minimum for noise estimation
            if (this.signalPower[k] < this.minTrack[k]) {
                this.minTrack[k] = this.signalPower[k];
            } else {
                // Slow rise
                this.minTrack[k] = 0.9999 * this.minTrack[k] + 0.0001 * this.signalPower[k];
            }
            
            // Noise estimate from minimum with bias compensation
            const noiseEst = this.minTrack[k] * 2.0;
            this.noisePower[k] = beta * this.noisePower[k] + (1 - beta) * noiseEst;
            
            // Spectral subtraction with over-subtraction
            const noiseMag = Math.sqrt(this.noisePower[k]) * overSub;
            let newMag = mag - noiseMag;
            
            // Half-wave rectification with floor
            newMag = Math.max(newMag, mag * gainFloor);
            
            // Calculate gain
            let gain = mag > 0 ? newMag / mag : gainFloor;
            gain = Math.max(gain, gainFloor);
            gain = Math.min(gain, 1.0);
            
            // Smooth gain temporally
            gain = gainSmooth * this.prevGain[k] + (1 - gainSmooth) * gain;
            this.prevGain[k] = gain;
            
            // Blend dry/wet
            const finalGain = 1.0 - this.amount + this.amount * gain;

            this.real[k] *= finalGain;
            this.imag[k] *= finalGain;

            if (k > 0 && k < this.numBins - 1) {
                this.real[N - k] = this.real[k];
                this.imag[N - k] = -this.imag[k];
            }
        }

        // Reset min tracking periodically
        if (this.frameCount % 500 === 0) {
            for (let k = 0; k < this.numBins; k++) {
                this.minTrack[k] = this.signalPower[k];
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

        // VAD decision based on spectral crest
        // Low value = voice (peaky spectrum), high value = noise (flat spectrum)
        const dynamicThreshold = this.flatnessThreshold - this.amount * 0.05;  // 0.35 to 0.30
        const voiceDetected = this.smoothedFlatness < dynamicThreshold;

        if (voiceDetected) {
            this.gateOpen = true;
            this.holdCounter = this.holdTime;
        } else if (this.holdCounter > 0) {
            this.holdCounter -= inp.length;
        } else {
            this.gateOpen = false;
        }

        // Level compensation: +9dB at max NR to compensate for filtered energy loss + gate
        const makeupGain = 1 + this.amount * 1.8;  // 1.0 to 2.8 (+0 to +9dB)

        // VAD gate based on spectral crest factor - depth controlled by NR slider
        const minGain = 0.25 - this.amount * 0.20;  // 0.25 (-12dB) to 0.05 (-26dB) at max NR
        const gateTarget = this.gateOpen ? 1.0 : minGain;
        const gateSpeed = this.gateOpen ? this.gateAttack : this.gateRelease;

        for (let i = 0; i < out.length; i++) {
            // Smooth gate gain transition
            this.gateGain += (gateTarget - this.gateGain) * gateSpeed;

            if (this.samplesIn > N) {
                if (this.enabled) {
                    // Apply NR output with makeup gain and soft gate
                    out[i] = this.outputRing[this.readIdx] * makeupGain * this.gateGain;
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
