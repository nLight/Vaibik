class PcmCollector extends AudioWorkletProcessor {
    constructor({ processorOptions }) {
        super();
        this.samples = new Float32Array(4096);
        this.offset = 0;
        this.collecting = !processorOptions?.waitForTrigger;
        this.finished = false;
        this.port.onmessage = event => {
            if (event.data === 'start') {
                this.collecting = true;
            } else if (event.data === 'finish') {
                this.flush();
                this.finished = true;
                this.port.postMessage('finished');
            }
        };
    }

    flush() {
        if (this.offset) {
            const packet = this.samples.slice(0, this.offset);
            this.port.postMessage(packet, [packet.buffer]);
            this.offset = 0;
        }
    }

    process(inputs) {
        if (this.finished) return false;
        if (!this.collecting) return true;
        const channel = inputs[0]?.[0];
        if (channel) for (const sample of channel) {
            this.samples[this.offset++] = sample;
            if (this.offset === this.samples.length) this.flush();
        }
        return true;
    }
}

registerProcessor('pcm-collector', PcmCollector);
