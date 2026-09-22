import type {
  AudioOpt,
  AudioSource,
  OutputFile,
  Overwrite,
  PresetSpec,
  Summary,
  TrackInfo,
  VideoFile,
} from "../store";

export type Trim = {
  start: number;
  end: number;
  customName?: string;
};

export type SpeedRange = {
  start: number;
  end: number;
  speed: number;
  fitTarget: boolean;
  targetDuration?: number;
};

export type BatchItemSpec = {
  path: string;
  duration: number | null;
  trims: Trim[];
  /** @deprecated single-range form, kept so older callers keep working. */
  speedRange?: SpeedRange | null;
  /** Zero or more non-overlapping speed ranges inside the trim. */
  speedRanges?: SpeedRange[] | null;
  audio: AudioOpt;
  audioSource: AudioSource;
  normalize: boolean;
  audioTracks: number;
  audioTracksInfo?: TrackInfo[];
};

export type BatchItem = BatchItemSpec;

export type BatchOptions = {
  preset: PresetSpec;
  outDir: string | null;
  parallel: number;
  overwrite: Overwrite;
  /** null = CPU x264; "nvenc" | "amf" | "qsv" (desktop only). */
  encoder: string | null;
  extraArgs: string[];
  lowPriority?: boolean;
  stripMetadata?: boolean;
  namingTemplate?: string;
  deleteSourceToTrash?: boolean;
};

export type BatchEvents = {
  fileStart: (index: number) => void;
  fileProgress: (index: number, percent: number) => void;
  fileDone: (
    index: number,
    ok: boolean,
    skipped: boolean,
    error: string | null,
    outputs: OutputFile[],
  ) => void;
  batchDone: (s: Summary) => void;
};

export type Capabilities = {
  /** Folder scanning ("Choose a folder"), incl. the subfolder toggle. */
  folders: boolean;
  /** Custom output folder + "Open output folder" + overwrite policy. */
  outputFolder: boolean;
  /** "Show" (reveal in file manager). */
  reveal: boolean;
  /** "Copy" (file on the OS clipboard). */
  clipboard: boolean;
  /** Dragging results out of the app. */
  dragOut: boolean;
  /** Per-output "Save" download links (the web way). */
  downloads: boolean;
  /** Parallel conversions + GPU encoders (desktop only). */
  advancedEncode: boolean;
};

export type Thumb = { url: string; iconPath: string | null };

export interface Engine {
  caps: Capabilities;
  /** Engine health check — resolves with a banner line, rejects with advice. */
  check(): Promise<string>;
  version(): Promise<string>;
  checkForUpdates(): void;
  openReleases(): void;
  /** GPU encoder ids present in this ffmpeg build ("nvenc"/"amf"/"qsv"). */
  listEncoders(): Promise<string[]>;

  pickFolder(recursive: boolean): Promise<{ folder: string; files: VideoFile[] } | null>;
  scanFolder(folder: string, recursive: boolean): Promise<VideoFile[]>;
  pickFiles(): Promise<VideoFile[]>;
  /** Subscribe to files dropped onto the window. Returns unsubscribe. */
  onDrop(cb: (files: VideoFile[]) => void): () => void;

  onBatchEvents(ev: BatchEvents): () => void;
  startBatch(items: BatchItemSpec[], options: BatchOptions): Promise<void>;
  cancelBatch(): void;
  skipFile(index: number): void;

  pickOutDir(): Promise<string | null>;
  openOutputFolder(anchor: string, presetName: string, outDir: string | null): void;
  revealFile(path: string): void;
  copyFiles(paths: string[]): Promise<void>;
  dragOut(paths: string[], icon: string): void;

  /** URL usable as <video>/<img> src for a queued source file. */
  mediaSrc(path: string): string;
  /** Small H.264 proxy for undecodable sources; rejects when unsupported. */
  preparePreviewProxy(path: string, onProgress?: (percent: number) => void, resolution?: number): Promise<string>;
  cancelPreviewProxy?(path: string): Promise<void>;
  prepareThumbnail(path: string, duration: number | null): Promise<Thumb>;
  extractTrackAudio(path: string, index: number): Promise<string>;
}
