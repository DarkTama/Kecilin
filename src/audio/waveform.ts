export function computePeaks(pcmData: Float32Array, numBuckets: number): Float32Array {
  if (numBuckets <= 0) return new Float32Array(0);
  const peaks = new Float32Array(numBuckets);
  if (pcmData.length === 0) return peaks;

  const bucketSize = pcmData.length / numBuckets;
  for (let i = 0; i < numBuckets; i++) {
    const start = Math.floor(i * bucketSize);
    const end = Math.min(pcmData.length, Math.floor((i + 1) * bucketSize));
    let max = 0;
    for (let j = start; j < end; j++) {
      const val = Math.abs(pcmData[j]);
      if (Number.isFinite(val) && val > max) max = val;
    }
    peaks[i] = max;
  }
  return peaks;
}

export async function generateWaveformData(
  audioUrl: string,
  numBuckets = 300
): Promise<Float32Array> {
  const resp = await fetch(audioUrl);
  const buffer = await resp.arrayBuffer();
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  try {
    const audioBuffer = await ctx.decodeAudioData(buffer);
    const channelData = audioBuffer.getChannelData(0);
    return computePeaks(channelData, numBuckets);
  } finally {
    void ctx.close();
  }
}
