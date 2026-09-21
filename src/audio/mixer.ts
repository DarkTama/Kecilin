export type TrackSourceConfig = {
  index: number;
  url: string;
  volume: number;
  muted: boolean;
};

export class AudioTrackMixer {
  private ctx: AudioContext | null = null;
  private gainNodes = new Map<number, GainNode>();
  private buffers = new Map<number, AudioBuffer>();
  private sources = new Map<number, AudioBufferSourceNode>();
  private isPlaying = false;
  private currentPlayhead = 0;

  constructor() {
    const AudioCtx =
      typeof window !== "undefined"
        ? window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        : undefined;
    if (AudioCtx) {
      this.ctx = new AudioCtx();
    }
  }

  async loadTrack(index: number, url: string): Promise<void> {
    if (!this.ctx) return;
    const resp = await fetch(url);
    if (!this.ctx) return;
    const ab = await resp.arrayBuffer();
    if (!this.ctx) return;
    const audioBuffer = await this.ctx.decodeAudioData(ab);
    if (!this.ctx) return;
    this.buffers.set(index, audioBuffer);

    if (!this.gainNodes.has(index)) {
      const g = this.ctx.createGain();
      g.connect(this.ctx.destination);
      this.gainNodes.set(index, g);
    }
  }

  setTrackVolume(index: number, volume: number, muted = false): void {
    const g = this.gainNodes.get(index);
    if (!g || !this.ctx) return;
    const target = muted ? 0 : volume;
    g.gain.setValueAtTime(target, this.ctx.currentTime);
  }

  play(fromTime = this.currentPlayhead): void {
    if (!this.ctx) return;
    this.stop();
    if (this.ctx.state === "suspended") {
      void this.ctx.resume();
    }
    this.isPlaying = true;
    this.currentPlayhead = fromTime;

    for (const [index, buffer] of this.buffers.entries()) {
      if (fromTime >= buffer.duration) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      const g = this.gainNodes.get(index);
      if (g) src.connect(g);
      src.start(0, Math.max(0, fromTime));
      this.sources.set(index, src);
    }
  }

  pause(): void {
    this.stop();
    this.isPlaying = false;
  }

  seek(toTime: number): void {
    if (this.isPlaying) {
      this.play(toTime);
    } else {
      this.currentPlayhead = toTime;
    }
  }

  getCurrentPlayhead(): number {
    return this.currentPlayhead;
  }

  private stop(): void {
    for (const src of this.sources.values()) {
      try {
        src.stop();
      } catch {
        // ignore if already stopped
      } finally {
        try {
          src.disconnect();
        } catch {
          // ignore disconnect errors
        }
      }
    }
    this.sources.clear();
  }

  dispose(): void {
    this.stop();
    for (const g of this.gainNodes.values()) {
      try {
        g.disconnect();
      } catch {
        // ignore
      }
    }
    this.gainNodes.clear();
    this.buffers.clear();
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
  }
}
