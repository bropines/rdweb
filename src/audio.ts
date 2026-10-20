// Remote audio: Opus packets decoded with WebCodecs and played through a
// small jitter buffer on an AudioContext.

const TARGET_LATENCY = 0.08; // seconds of audio queued ahead
const MAX_LATENCY = 0.4; // beyond this we drop queued audio and resync

export function isAudioDecodingAvailable(): boolean {
  return typeof globalThis.AudioDecoder === "function" && typeof globalThis.AudioContext === "function";
}

export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private decoder: AudioDecoder | null = null;
  private sampleRate = 0;
  private channels = 0;
  private nextTime = 0;
  private ts = 0;
  private muted = false;
  private volume = 1;

  /** Applies a new stream format announced by the peer. */
  configure(sampleRate: number, channels: number): void {
    if (!isAudioDecodingAvailable()) return;
    if (sampleRate === this.sampleRate && channels === this.channels && this.decoder) return;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.closeDecoder();
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: "interactive" });
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
      this.applyGain();
    }
    const decoder = new AudioDecoder({
      output: (data) => this.play(data),
      error: () => {
        if (this.decoder === decoder) this.decoder = null;
      },
    });
    try {
      decoder.configure({ codec: "opus", sampleRate, numberOfChannels: channels });
      this.decoder = decoder;
    } catch {
      this.decoder = null;
    }
  }

  push(packet: Uint8Array): void {
    if (this.muted || !this.decoder || this.decoder.state !== "configured") return;
    try {
      this.decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: (this.ts += 10_000), data: packet }));
    } catch {
      /* a broken packet is not worth tearing the session down for */
    }
  }

  /** Browsers only start audio after a user gesture; call this from one. */
  resume(): void {
    void this.ctx?.resume().catch(() => {});
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyGain();
    if (muted) this.nextTime = 0;
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    this.applyGain();
  }

  close(): void {
    this.closeDecoder();
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.gain = null;
  }

  private applyGain(): void {
    if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume;
  }

  private closeDecoder(): void {
    if (this.decoder && this.decoder.state !== "closed") {
      try {
        this.decoder.close();
      } catch {
        /* ignore */
      }
    }
    this.decoder = null;
  }

  private play(data: AudioData): void {
    const ctx = this.ctx;
    if (!ctx || !this.gain || this.muted) {
      data.close();
      return;
    }
    try {
      const frames = data.numberOfFrames;
      const chans = data.numberOfChannels;
      const buf = ctx.createBuffer(chans, frames, data.sampleRate);
      for (let c = 0; c < chans; c++) {
        const plane = new Float32Array(frames);
        data.copyTo(plane, { planeIndex: c, format: "f32-planar" });
        buf.copyToChannel(plane, c);
      }
      const now = ctx.currentTime;
      if (this.nextTime < now || this.nextTime - now > MAX_LATENCY) this.nextTime = now + TARGET_LATENCY;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.gain);
      src.start(this.nextTime);
      this.nextTime += buf.duration;
    } catch {
      /* ignore */
    } finally {
      data.close();
    }
  }
}
