class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const requestedChunkSize = Number(options?.processorOptions?.chunkSize || 4096);
    this.chunkSize = Number.isFinite(requestedChunkSize) && requestedChunkSize > 0
      ? requestedChunkSize
      : 4096;
    this.pending = new Float32Array(0);
    this.stopped = false;

    this.port.onmessage = (event) => {
      if (event?.data?.type === 'stop') {
        this.stopped = true;
      }
    };
  }

  process(inputs, outputs) {
    if (this.stopped) {
      return false;
    }

    const input = inputs?.[0]?.[0];
    const output = outputs?.[0]?.[0];

    if (output) {
      output.fill(0);
    }

    if (!input || input.length === 0) {
      return true;
    }

    const merged = new Float32Array(this.pending.length + input.length);
    merged.set(this.pending, 0);
    merged.set(input, this.pending.length);

    let offset = 0;
    while ((merged.length - offset) >= this.chunkSize) {
      const frame = merged.slice(offset, offset + this.chunkSize);
      this.port.postMessage(frame, [frame.buffer]);
      offset += this.chunkSize;
    }

    this.pending = merged.slice(offset);
    return true;
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
