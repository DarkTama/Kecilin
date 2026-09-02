use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Video extensions the scanner accepts (same list as compress.bat).
const VIDEO_EXTS: [&str; 5] = ["mp4", "mov", "mkv", "avi", "webm"];

/// A preset: one of the three built-ins (verbatim from compress.bat) or a
/// user-defined one from the Advanced panel.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PresetSpec {
    pub name: String,
    pub height: u32,
    pub crf: u32,
    pub maxrate: String,
    pub bufsize: String,
    pub level: String,
}

impl PresetSpec {
    fn new(name: &str, height: u32, crf: u32, maxrate: &str, bufsize: &str, level: &str) -> Self {
        Self {
            name: name.into(),
            height,
            crf,
            maxrate: maxrate.into(),
            bufsize: bufsize.into(),
            level: level.into(),
        }
    }
}

pub(crate) fn builtin_preset(name: &str) -> Option<PresetSpec> {
    match name {
        "360p" => Some(PresetSpec::new("360p", 360, 24, "1200k", "2400k", "3.1")),
        "480p" => Some(PresetSpec::new("480p", 480, 22, "2200k", "4400k", "3.1")),
        "720p" => Some(PresetSpec::new("720p", 720, 20, "4200k", "8400k", "4.1")),
        _ => None,
    }
}

/// Filesystem-safe preset name for `whatsapp_{preset}` folders and suffixes.
pub(crate) fn slug(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let trimmed = s.trim_matches('_');
    if trimmed.is_empty() { "custom".into() } else { trimmed.to_string() }
}

#[derive(Default)]
pub struct BatchState {
    running: AtomicBool,
    cancel: AtomicBool,
    /// Live ffmpeg children by queue index (several when converting in parallel).
    children: Mutex<HashMap<usize, CommandChild>>,
    /// Indices the user asked to skip; consumed when the killed child reports back.
    skipped: Mutex<HashSet<usize>>,
}

impl BatchState {
    fn kill(&self, index: usize) {
        if let Ok(mut map) = self.children.lock() {
            if let Some(child) = map.remove(&index) {
                let _ = child.kill();
            }
        }
    }

    /// Cancel the whole batch: raise the flag and kill every running child.
    pub fn abort(&self) {
        self.cancel.store(true, Ordering::SeqCst);
        if let Ok(mut map) = self.children.lock() {
            for (_, child) in map.drain() {
                let _ = child.kill();
            }
        }
    }

    /// Skip one file: kill its child; the batch moves on.
    pub fn skip_file(&self, index: usize) {
        if let Ok(mut set) = self.skipped.lock() {
            set.insert(index);
        }
        self.kill(index);
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VideoFile {
    path: String,
    name: String,
    size: u64,
    duration: Option<f64>,
    /// Number of audio streams (OBS multi-track recordings have several).
    audio_tracks: usize,
}

#[derive(Deserialize, Clone, Copy)]
pub struct Trim {
    pub start: f64,
    pub end: f64,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BatchItem {
    pub path: String,
    pub duration: Option<f64>,
    /// Zero ranges = convert the whole file; one = plain trim; several =
    /// multi-part split (`_part1`, `_part2`, … outputs).
    #[serde(default)]
    pub trims: Vec<Trim>,
    /// None = keep audio as-is; "mute" = drop the track; "75"/"50"/"25" = volume.
    #[serde(default)]
    pub audio: Option<String>,
    /// None/"default" = first track; "merge" = mix all tracks; "0","1",… = pick one.
    #[serde(default)]
    pub audio_source: Option<String>,
    /// Loudness-normalize the audio (one-pass loudnorm).
    #[serde(default)]
    pub normalize: bool,
    /// Audio stream count from the scan (needed to build the merge filter).
    #[serde(default)]
    pub audio_tracks: usize,
}

/// Batch-wide options from the UI (presets + the Advanced panel).
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BatchOptions {
    pub preset: PresetSpec,
    pub out_dir: Option<String>,
    /// Concurrent conversions; 0/1 = sequential (the script's behavior).
    #[serde(default)]
    pub parallel: usize,
    /// "overwrite" (script's -y, default) | "skip" | "rename" (keep both).
    #[serde(default)]
    pub overwrite: String,
    /// None = libx264 (the script); "nvenc" | "amf" | "qsv" = GPU encoders.
    #[serde(default)]
    pub encoder: Option<String>,
    /// Extra ffmpeg arguments appended right before the output path.
    #[serde(default)]
    pub extra_args: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct OutputFile {
    path: String,
    size: u64,
}

#[derive(Serialize, Clone)]
struct FileStart {
    index: usize,
}

#[derive(Serialize, Clone)]
struct FileProgress {
    index: usize,
    percent: f64,
}

#[derive(Serialize, Clone)]
struct FileDone {
    index: usize,
    ok: bool,
    skipped: bool,
    error: Option<String>,
    outputs: Vec<OutputFile>,
}

#[derive(Serialize, Clone)]
struct BatchDone {
    converted: u32,
    failed: u32,
    skipped: u32,
    canceled: bool,
}

/// Count audio streams in ffmpeg's stderr header (`Stream #0:1...: Audio: …`).
pub(crate) fn parse_audio_tracks(stderr: &str) -> usize {
    stderr
        .lines()
        .filter(|l| l.contains("Stream #") && l.contains("Audio:"))
        .count()
}

/// Parse `Duration: HH:MM:SS.cc` from ffmpeg's stderr header. `N/A` → None.
pub(crate) fn parse_duration_secs(stderr: &str) -> Option<f64> {
    let rest = &stderr[stderr.find("Duration: ")? + "Duration: ".len()..];
    let token = rest.split(',').next()?.trim();
    let mut it = token.split(':');
    let h: f64 = it.next()?.trim().parse().ok()?;
    let m: f64 = it.next()?.parse().ok()?;
    let s: f64 = it.next()?.parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + s)
}

/// Parse an `ffmpeg -progress` line into elapsed output microseconds.
/// `out_time_us=` and `out_time_ms=` are BOTH microseconds (a long-standing
/// ffmpeg quirk); values before the first frame can be negative or `N/A`.
pub(crate) fn parse_progress_us(line: &str) -> Option<u64> {
    let v = line
        .strip_prefix("out_time_us=")
        .or_else(|| line.strip_prefix("out_time_ms="))?;
    v.trim().parse::<i64>().ok().map(|n| n.max(0) as u64)
}

fn push_strs(args: &mut Vec<String>, xs: &[&str]) {
    args.extend(xs.iter().map(|s| s.to_string()));
}

/// "2200k" → 2200.
fn kbps(rate: &str) -> Option<u32> {
    rate.trim_end_matches(['k', 'K']).parse().ok()
}

/// Per-file audio choices, resolved from the queue item.
#[derive(Default, Clone, Copy)]
pub(crate) struct AudioOpts<'a> {
    /// None/"default" = first track (`0:a?`); "merge" = mix all; "0","1",… = pick one.
    pub source: Option<&'a str>,
    /// None = keep; "mute" = drop the track; "75"/"50"/"25" = volume.
    pub level: Option<&'a str>,
    /// One-pass loudnorm.
    pub normalize: bool,
    /// Audio stream count (merge needs it; <2 degrades to default).
    pub track_count: usize,
}

const LOUDNORM: &str = "loudnorm=I=-16:TP=-1.5:LRA=11";

/// The video encoder block. None = libx264 exactly as compress.bat; the GPU
/// encoders keep the same rate ceiling (maxrate/bufsize) and GOP, trading the
/// x264 tuning for speed.
fn video_args(p: &PresetSpec, encoder: Option<&str>) -> Vec<String> {
    let crf = p.crf.to_string();
    let mut a = Vec::new();
    match encoder {
        Some("nvenc") => push_strs(&mut a, &[
            "-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr",
            "-cq", &crf, "-b:v", "0", "-maxrate", &p.maxrate, "-bufsize", &p.bufsize,
            "-profile:v", "high", "-level", &p.level, "-pix_fmt", "yuv420p",
            "-g", "120", "-bf", "3",
        ]),
        Some("amf") => {
            // AMF has no CRF-style mode worth trusting; aim ~60% of the ceiling.
            let target = format!("{}k", kbps(&p.maxrate).unwrap_or(2000) * 6 / 10);
            push_strs(&mut a, &[
                "-c:v", "h264_amf", "-usage", "transcoding", "-quality", "quality",
                "-rc", "vbr_peak", "-b:v", &target, "-maxrate", &p.maxrate, "-bufsize", &p.bufsize,
                "-profile:v", "high", "-level", &p.level, "-pix_fmt", "yuv420p",
                "-g", "120", "-bf", "3",
            ])
        }
        Some("qsv") => push_strs(&mut a, &[
            "-c:v", "h264_qsv", "-preset", "slower", "-global_quality", &crf, "-look_ahead", "1",
            "-maxrate", &p.maxrate, "-bufsize", &p.bufsize,
            "-profile:v", "high", "-level", &p.level, "-pix_fmt", "nv12",
            "-g", "120", "-bf", "3",
        ]),
        _ => push_strs(&mut a, &[
            "-c:v", "libx264", "-preset", "slow", "-profile:v", "high",
            "-level", &p.level, "-pix_fmt", "yuv420p",
            "-crf", &crf, "-maxrate", &p.maxrate, "-bufsize", &p.bufsize,
            "-g", "120", "-keyint_min", "60", "-sc_threshold", "40",
            "-bf", "3", "-refs", "4", "-rc-lookahead", "40",
            "-x264-params", "aq-mode=3:aq-strength=0.8",
        ]),
    }
    a
}

/// Build the exact ffmpeg invocation from compress.bat (see docs/ARCHITECTURE.md).
/// Trim adds `-ss` before `-i` (fast input seek) and `-t` after it; the
/// `-progress pipe:1 -nostats` pair only affects reporting, not the encode.
/// Audio: chain order is amix → loudnorm → volume; mute wins over everything.
/// `extra` lands right before the output path so user flags override ours.
pub(crate) fn build_ffmpeg_args(
    input: &str,
    output: &str,
    p: &PresetSpec,
    trim: Option<&Trim>,
    audio: AudioOpts,
    encoder: Option<&str>,
    extra: &[String],
) -> Vec<String> {
    let mut a: Vec<String> = vec!["-y".into()];
    if let Some(t) = trim {
        push_strs(&mut a, &["-ss", &format!("{:.3}", t.start)]);
    }
    push_strs(&mut a, &["-i", input]);
    if let Some(t) = trim {
        push_strs(&mut a, &["-t", &format!("{:.3}", (t.end - t.start).max(0.0))]);
    }
    let vf = format!("scale=-2:{}:flags=lanczos", p.height);
    let mute = audio.level == Some("mute");
    let merge = audio.source == Some("merge") && audio.track_count >= 2;

    // Post-source audio filters, chained in order.
    let mut af: Vec<String> = Vec::new();
    if audio.normalize {
        af.push(LOUDNORM.to_string());
    }
    match audio.level {
        Some("75") => af.push("volume=0.75".into()),
        Some("50") => af.push("volume=0.5".into()),
        Some("25") => af.push("volume=0.25".into()),
        _ => {}
    }

    push_strs(&mut a, &["-map", "0:v:0"]);
    if !mute {
        if merge {
            // Explicit input labels; normalize=0 keeps each source at its
            // recorded level; extra filters chain INSIDE the complex graph.
            let inputs: String =
                (0..audio.track_count).map(|i| format!("[0:a:{i}]")).collect();
            let chain = if af.is_empty() { String::new() } else { format!(",{}", af.join(",")) };
            let graph = format!(
                "{inputs}amix=inputs={}:duration=longest:normalize=0{chain}[aout]",
                audio.track_count
            );
            push_strs(&mut a, &["-filter_complex", &graph, "-map", "[aout]"]);
        } else if let Some(idx) = audio.source.filter(|s| s.chars().all(|c| c.is_ascii_digit())) {
            push_strs(&mut a, &["-map", &format!("0:a:{idx}")]);
        } else {
            push_strs(&mut a, &["-map", "0:a?"]);
        }
    }
    push_strs(&mut a, &["-vf", &vf]);
    a.extend(video_args(p, encoder));
    if mute {
        push_strs(&mut a, &["-an"]);
    } else {
        if !merge && !af.is_empty() {
            push_strs(&mut a, &["-af", &af.join(",")]);
        }
        push_strs(&mut a, &["-c:a", "aac", "-q:a", "2", "-ar", "48000", "-ac", "2"]);
    }
    push_strs(&mut a, &["-movflags", "+faststart", "-progress", "pipe:1", "-nostats"]);
    a.extend(extra.iter().cloned());
    a.push(output.to_string());
    a
}

/// Per-platform advice when ffmpeg can't run.
const FFMPEG_HINT: &str = if cfg!(windows) {
    "Run scripts/fetch-binaries.ps1 (dev) or reinstall Kecilin."
} else {
    "Install ffmpeg from your distribution (e.g. pacman -S ffmpeg)."
};

fn ffmpeg(app: &AppHandle) -> Result<tauri_plugin_shell::process::Command, String> {
    #[cfg(windows)]
    {
        // Resolved as <exe_dir>/ffmpeg.exe — the WHOLE argument is joined onto
        // the exe dir, so it must be the bare name, not "binaries/ffmpeg" (that
        // would look for <exe_dir>/binaries/ffmpeg.exe, which exists nowhere:
        // tauri-build and the bundler both lay the sidecar flat next to the exe).
        app.shell()
            .sidecar("ffmpeg")
            .map_err(|e| format!("ffmpeg sidecar unavailable: {e}. {FFMPEG_HINT}"))
    }
    #[cfg(not(windows))]
    {
        // Linux/macOS: no bundled sidecar — the system ffmpeg is a package
        // dependency (the AUR/deb way), always current and distro-blessed.
        Ok(app.shell().command("ffmpeg"))
    }
}

/// Sidecar self-check: run `ffmpeg -version`, return the banner line.
#[tauri::command]
pub async fn check_ffmpeg(app: AppHandle) -> Result<String, String> {
    let out = ffmpeg(&app)?
        .args(["-version"])
        .output()
        .await
        .map_err(|e| format!("ffmpeg failed to start: {e}. {FFMPEG_HINT}"))?;
    if !out.status.success() {
        return Err(format!("ffmpeg self-check failed (exit {:?})", out.status.code()));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    Ok(stdout.lines().next().unwrap_or("ffmpeg").to_string())
}

/// Which GPU H.264 encoders this ffmpeg build ships ("nvenc"/"amf"/"qsv").
/// Presence in the build ≠ working hardware; a failed encode reports itself.
#[tauri::command]
pub async fn list_encoders(app: AppHandle) -> Result<Vec<String>, String> {
    let out = ffmpeg(&app)?
        .args(["-hide_banner", "-encoders"])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    let names: HashSet<&str> = text.lines().filter_map(|l| l.split_whitespace().nth(1)).collect();
    Ok([("nvenc", "h264_nvenc"), ("amf", "h264_amf"), ("qsv", "h264_qsv")]
        .iter()
        .filter(|(_, enc)| names.contains(enc))
        .map(|(id, _)| id.to_string())
        .collect())
}

fn is_video(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| VIDEO_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Probe durations for already-vetted files. Duration comes from ffmpeg's own
/// header output — no ffprobe needed; ffmpeg exits non-zero without an output
/// file but the header still prints.
async fn probe_files(
    app: &AppHandle,
    found: Vec<(PathBuf, String, u64)>,
) -> Result<Vec<VideoFile>, String> {
    let mut files = Vec::with_capacity(found.len());
    for (p, name, size) in found {
        let path_str = p.to_str().unwrap().to_string(); // UTF-8 checked by callers
        let (duration, audio_tracks) =
            match ffmpeg(app)?.args(["-hide_banner", "-i", &path_str]).output().await {
                Ok(out) => {
                    let stderr = String::from_utf8_lossy(&out.stderr);
                    (parse_duration_secs(&stderr), parse_audio_tracks(&stderr))
                }
                Err(_) => (None, 0),
            };
        files.push(VideoFile { path: path_str, name, size, duration, audio_tracks });
    }
    Ok(files)
}

/// Collect videos under `dir`. Recursive mode skips hidden folders and our own
/// `whatsapp_*` output folders (so a rescan never re-queues converted files).
fn walk(dir: &Path, recursive: bool, found: &mut Vec<(PathBuf, String, u64)>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let p = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if p.is_dir() {
            if recursive && !name.starts_with('.') && !name.starts_with("whatsapp_") {
                walk(&p, true, found);
            }
            continue;
        }
        // Non-UTF-8 paths can't cross the IPC/argument boundary; skip them.
        if !p.is_file() || !is_video(&p) || p.to_str().is_none() {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        found.push((p, name, size));
    }
}

/// List videos in `path` — top level only (the script's behavior) unless
/// `recursive`.
#[tauri::command]
pub async fn scan_directory(
    app: AppHandle,
    path: String,
    recursive: bool,
) -> Result<Vec<VideoFile>, String> {
    fs::read_dir(&path).map_err(|e| format!("cannot read folder: {e}"))?;
    let mut found: Vec<(PathBuf, String, u64)> = Vec::new();
    walk(Path::new(&path), recursive, &mut found);
    found.sort_by(|a, b| {
        a.0.to_string_lossy().to_lowercase().cmp(&b.0.to_string_lossy().to_lowercase())
    });
    probe_files(&app, found).await
}

/// Probe individually picked files (from the file dialog); non-videos and
/// missing paths are silently skipped. Order is preserved.
#[tauri::command]
pub async fn scan_files(app: AppHandle, paths: Vec<String>) -> Result<Vec<VideoFile>, String> {
    let mut found: Vec<(PathBuf, String, u64)> = Vec::new();
    for path in paths {
        let p = PathBuf::from(&path);
        if !p.is_file() || !is_video(&p) || p.to_str().is_none() {
            continue;
        }
        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone());
        let size = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        found.push((p, name, size));
    }
    probe_files(&app, found).await
}

/// Kick off a batch conversion. Returns immediately; progress and completion
/// arrive as `file:*` / `batch:done` events.
#[tauri::command]
pub fn start_batch(
    app: AppHandle,
    state: State<'_, BatchState>,
    items: Vec<BatchItem>,
    options: BatchOptions,
) -> Result<(), String> {
    if items.is_empty() {
        return Err("nothing to convert".into());
    }
    if state.running.swap(true, Ordering::SeqCst) {
        return Err("a batch is already running".into());
    }
    state.cancel.store(false, Ordering::SeqCst);
    if let Ok(mut set) = state.skipped.lock() {
        set.clear();
    }
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move { run_batch(app2, items, options).await });
    Ok(())
}

#[tauri::command]
pub fn cancel_batch(state: State<'_, BatchState>) {
    state.abort();
}

/// Skip one queued/running file; the rest of the batch continues.
#[tauri::command]
pub fn skip_file(state: State<'_, BatchState>, index: usize) {
    state.skip_file(index);
}

fn stable_hash(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

/// Cache file path for a derived artifact of `path`, keyed by path+mtime+size
/// so an edited source gets a fresh entry.
fn cache_file(app: &AppHandle, sub: &str, path: &str, ext: &str) -> Result<PathBuf, String> {
    let meta = fs::metadata(path).map_err(|e| format!("cannot read file: {e}"))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let key = format!("{path}|{mtime}|{}", meta.len());
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join(sub);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{:016x}.{ext}", stable_hash(&key))))
}

/// Re-encode a small H.264/AAC proxy so the webview can preview formats it
/// can't decode natively (HEVC, .mkv, .avi, …). Cached; cheap `veryfast` 360p.
#[tauri::command]
pub async fn prepare_preview(app: AppHandle, path: String) -> Result<String, String> {
    let out = cache_file(&app, "previews", &path, "mp4")?;
    let out_str = out.to_str().ok_or("cache path is not valid UTF-8")?.to_string();
    if out.exists() {
        return Ok(out_str);
    }
    let output = ffmpeg(&app)?
        .args([
            "-y", "-i", &path, "-map", "0:v:0", "-map", "0:a?", "-sn", "-dn",
            "-vf", "scale=-2:360", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
            "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", "-ar", "48000",
            "-movflags", "+faststart", &out_str,
        ])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !output.status.success() || !out.exists() {
        let _ = fs::remove_file(&out);
        return Err(last_error_line(
            &String::from_utf8_lossy(&output.stderr),
            output.status.code(),
        ));
    }
    Ok(out_str)
}

/// One frame as a small JPEG for the queue row. Seeks ~10% in (capped at 30s);
/// retries at 0 for very short files where the seek overshoots.
#[tauri::command]
pub async fn prepare_thumbnail(
    app: AppHandle,
    path: String,
    duration: Option<f64>,
) -> Result<String, String> {
    let out = cache_file(&app, "thumbs", &path, "jpg")?;
    let out_str = out.to_str().ok_or("cache path is not valid UTF-8")?.to_string();
    if out.exists() {
        return Ok(out_str);
    }
    let seek = duration.map(|d| (d * 0.1).clamp(0.0, 30.0)).unwrap_or(0.0);
    for ss in [seek, 0.0] {
        let output = ffmpeg(&app)?
            .args([
                "-y", "-ss", &format!("{ss:.3}"), "-i", &path,
                "-frames:v", "1", "-vf", "scale=-2:90", "-q:v", "5", &out_str,
            ])
            .output()
            .await
            .map_err(|e| e.to_string())?;
        if output.status.success() && out.exists() {
            return Ok(out_str);
        }
        let _ = fs::remove_file(&out);
        if ss == 0.0 {
            return Err(last_error_line(
                &String::from_utf8_lossy(&output.stderr),
                output.status.code(),
            ));
        }
    }
    unreachable!()
}

/// Drop cached previews/thumbnails older than a week. Called on startup.
pub fn cleanup_cache(app: &AppHandle) {
    let Ok(base) = app.path().app_cache_dir() else { return };
    for sub in ["previews", "thumbs"] {
        let Ok(rd) = fs::read_dir(base.join(sub)) else { continue };
        for entry in rd.flatten() {
            let old = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.elapsed().ok())
                .map(|d| d.as_secs() > 7 * 24 * 3600)
                .unwrap_or(false);
            if old {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

/// Open the batch output folder in the file manager. `anchor` is any converted
/// file's input path; with no custom `out_dir` the output sits next to it.
#[tauri::command]
pub fn open_output_folder(
    anchor: String,
    preset: String,
    out_dir: Option<String>,
) -> Result<(), String> {
    let dir = match out_dir {
        Some(d) => PathBuf::from(d),
        None => Path::new(&anchor)
            .parent()
            .ok_or("no parent folder")?
            .join(format!("whatsapp_{}", slug(&preset))),
    };
    tauri_plugin_opener::open_path(dir, None::<&str>).map_err(|e| e.to_string())
}

/// Where a converted file lands: inside the custom output dir if set, else in
/// `whatsapp_{preset}` next to the input (the script's layout). `part` appends
/// `_partN` for multi-part splits.
pub(crate) fn output_path(
    input: &Path,
    preset: &PresetSpec,
    out_dir: Option<&str>,
    part: Option<usize>,
) -> Option<PathBuf> {
    let stem = input.file_stem()?.to_string_lossy();
    let tag = slug(&preset.name);
    let dir = match out_dir {
        Some(d) => PathBuf::from(d),
        None => input.parent()?.join(format!("whatsapp_{tag}")),
    };
    let suffix = part.map(|n| format!("_part{n}")).unwrap_or_default();
    Some(dir.join(format!("{stem}_whatsapp_{tag}{suffix}.mp4")))
}

/// `clip.mp4` → `clip_2.mp4`, `clip_3.mp4`, … first one that doesn't exist.
pub(crate) fn unique_path(path: &Path) -> PathBuf {
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = path.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default();
    let dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
    (2..)
        .map(|n| dir.join(format!("{stem}_{n}.{ext}")))
        .find(|p| !p.exists())
        .unwrap_or_else(|| path.to_path_buf())
}

enum ConvErr {
    Failed(String),
    Skipped(String),
}

async fn run_batch(app: AppHandle, items: Vec<BatchItem>, opts: BatchOptions) {
    let parallel = opts.parallel.max(1);
    let sem = Arc::new(tokio::sync::Semaphore::new(parallel));
    let opts = Arc::new(opts);
    let mut handles = Vec::with_capacity(items.len());
    for (index, item) in items.into_iter().enumerate() {
        // Wait for a slot before spawning, so at most `parallel` run at once.
        let Ok(permit) = sem.clone().acquire_owned().await else { break };
        if app.state::<BatchState>().cancel.load(Ordering::SeqCst) {
            break;
        }
        let app2 = app.clone();
        let opts2 = opts.clone();
        handles.push(tauri::async_runtime::spawn(async move {
            let _permit = permit;
            let _ = app2.emit("file:start", FileStart { index });
            match convert_one(&app2, &item, &opts2, index).await {
                Ok(outputs) => {
                    let _ = app2.emit(
                        "file:done",
                        FileDone { index, ok: true, skipped: false, error: None, outputs },
                    );
                    (1u32, 0u32, 0u32)
                }
                Err(ConvErr::Skipped(reason)) => {
                    let _ = app2.emit(
                        "file:done",
                        FileDone { index, ok: false, skipped: true, error: Some(reason), outputs: vec![] },
                    );
                    (0, 0, 1)
                }
                Err(ConvErr::Failed(e)) => {
                    // A cancel kills the child mid-file; that's not a real failure.
                    if app2.state::<BatchState>().cancel.load(Ordering::SeqCst) {
                        return (0, 0, 0);
                    }
                    let _ = app2.emit(
                        "file:done",
                        FileDone { index, ok: false, skipped: false, error: Some(e), outputs: vec![] },
                    );
                    (0, 1, 0)
                }
            }
        }));
    }
    let (mut converted, mut failed, mut skipped) = (0u32, 0u32, 0u32);
    for h in handles {
        if let Ok((c, f, s)) = h.await {
            converted += c;
            failed += f;
            skipped += s;
        }
    }
    let state = app.state::<BatchState>();
    let canceled = state.cancel.swap(false, Ordering::SeqCst);
    state.running.store(false, Ordering::SeqCst);
    let _ = app.emit("batch:done", BatchDone { converted, failed, skipped, canceled });

    // Batches run for minutes and people tab away — toast when unfocused.
    let focused = app
        .get_webview_window("main")
        .and_then(|w| w.is_focused().ok())
        .unwrap_or(false);
    if !focused && !canceled {
        use tauri_plugin_notification::NotificationExt;
        let body = if failed > 0 {
            format!("{converted} converted, {failed} failed")
        } else {
            format!("{converted} converted")
        };
        let _ = app
            .notification()
            .builder()
            .title("Kecilin — batch finished")
            .body(body)
            .show();
    }
}

/// Convert one queue item: a single encode for the whole file or one trim
/// range, or several sequential encodes for a multi-part split. Returns the
/// produced output files (path + size) for the result stats.
async fn convert_one(
    app: &AppHandle,
    item: &BatchItem,
    opts: &BatchOptions,
    index: usize,
) -> Result<Vec<OutputFile>, ConvErr> {
    let seg_count = item.trims.len().max(1);
    let mut outputs = Vec::with_capacity(seg_count);
    for seg_idx in 0..seg_count {
        let trim = item.trims.get(seg_idx);
        let part = if item.trims.len() > 1 { Some(seg_idx + 1) } else { None };
        let out = convert_segment(app, item, opts, index, trim, part, seg_idx, seg_count)
            .await
            .map_err(|e| match (e, part) {
                (ConvErr::Failed(msg), Some(n)) => ConvErr::Failed(format!("part {n}: {msg}")),
                (other, _) => other,
            })?;
        outputs.push(out);
    }
    Ok(outputs)
}

#[allow(clippy::too_many_arguments)]
async fn convert_segment(
    app: &AppHandle,
    item: &BatchItem,
    opts: &BatchOptions,
    index: usize,
    trim: Option<&Trim>,
    part: Option<usize>,
    seg_idx: usize,
    seg_count: usize,
) -> Result<OutputFile, ConvErr> {
    let fail = |m: String| ConvErr::Failed(m);
    let input = Path::new(&item.path);
    let mut out_path = output_path(input, &opts.preset, opts.out_dir.as_deref(), part)
        .ok_or_else(|| fail("file has no name or parent".into()))?;
    if out_path.exists() {
        match opts.overwrite.as_str() {
            "skip" => return Err(ConvErr::Skipped("output already exists".into())),
            "rename" => out_path = unique_path(&out_path),
            _ => {} // overwrite — the script's -y
        }
    }
    let dir = out_path.parent().ok_or_else(|| fail("output has no parent folder".into()))?;
    fs::create_dir_all(dir).map_err(|e| fail(format!("cannot create output folder: {e}")))?;
    let out_str = out_path
        .to_str()
        .ok_or_else(|| fail("output path is not valid UTF-8".into()))?
        .to_string();

    // Progress denominator: the trimmed range if set, else the scanned duration.
    let denom_us: Option<f64> = trim
        .map(|t| (t.end - t.start).max(0.0))
        .or(item.duration)
        .map(|s| s * 1_000_000.0)
        .filter(|v| *v > 0.0);

    let audio = AudioOpts {
        source: item.audio_source.as_deref(),
        level: item.audio.as_deref(),
        normalize: item.normalize,
        track_count: item.audio_tracks,
    };
    let args = build_ffmpeg_args(
        &item.path,
        &out_str,
        &opts.preset,
        trim,
        audio,
        opts.encoder.as_deref(),
        &opts.extra_args,
    );
    let (mut rx, child) = ffmpeg(app)
        .map_err(fail)?
        .args(args)
        .spawn()
        .map_err(|e| fail(e.to_string()))?;

    let state = app.state::<BatchState>();
    if let Ok(mut map) = state.children.lock() {
        map.insert(index, child);
    }

    let mut stderr_tail = String::new();
    let mut code: Option<i32> = None;
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    while let Some(ev) = rx.recv().await {
        match ev {
            CommandEvent::Stdout(bytes) => {
                if let (Some(us), Some(denom)) =
                    (parse_progress_us(&String::from_utf8_lossy(&bytes)), denom_us)
                {
                    let seg_pct = (us as f64 / denom).clamp(0.0, 1.0);
                    // Aggregate across the file's segments so the row's bar
                    // runs 0→100 once even for a multi-part split.
                    let percent = ((seg_idx as f64 + seg_pct) / seg_count as f64) * 100.0;
                    if last_emit.elapsed() >= Duration::from_millis(250) {
                        last_emit = Instant::now();
                        let _ = app.emit("file:progress", FileProgress { index, percent });
                    }
                }
            }
            CommandEvent::Stderr(bytes) => {
                stderr_tail.push_str(&String::from_utf8_lossy(&bytes));
                stderr_tail.push('\n');
                // Keep the tail; ffmpeg's useful error line is near the end.
                if stderr_tail.len() > 8192 {
                    let cut = stderr_tail.len() - 8192;
                    stderr_tail.drain(..cut);
                }
            }
            CommandEvent::Error(e) => {
                stderr_tail.push_str(&e);
                stderr_tail.push('\n');
            }
            CommandEvent::Terminated(t) => code = t.code,
            _ => {}
        }
    }
    if let Ok(mut map) = state.children.lock() {
        map.remove(&index);
    }
    let user_skipped = state.skipped.lock().map(|mut s| s.remove(&index)).unwrap_or(false);

    if code == Some(0) && out_path.exists() && !user_skipped {
        let size = fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
        Ok(OutputFile { path: out_str, size })
    } else {
        // Don't leave a corrupt partial file that looks converted.
        let _ = fs::remove_file(&out_path);
        if user_skipped {
            Err(ConvErr::Skipped("skipped".into()))
        } else {
            Err(ConvErr::Failed(last_error_line(&stderr_tail, code)))
        }
    }
}

fn last_error_line(stderr: &str, code: Option<i32>) -> String {
    stderr
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| l.to_string())
        .unwrap_or_else(|| format!("ffmpeg exited with code {code:?}"))
}

/// Reveal a converted file in the system file manager.
#[tauri::command]
pub fn reveal_file(path: String) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(|e| e.to_string())
}

/// Put files on the OS clipboard (as files, not text) so they can be pasted
/// into WhatsApp/Explorer with Ctrl+V. Multi-part outputs paste together.
#[tauri::command]
pub fn copy_file_to_clipboard(paths: Vec<String>) -> Result<(), String> {
    #[cfg(windows)]
    {
        use clipboard_win::{Clipboard, Setter};
        let _clip = Clipboard::new_attempts(10).map_err(|e| format!("clipboard busy: {e}"))?;
        clipboard_win::formats::FileList
            .write_clipboard(&paths[..])
            .map_err(|e| format!("clipboard error: {e}"))
    }
    #[cfg(not(windows))]
    {
        let _ = paths;
        Err("copy-as-file is not supported on this platform".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn audio(level: Option<&'static str>) -> AudioOpts<'static> {
        AudioOpts { level, ..Default::default() }
    }

    fn args(input: &str, output: &str, preset: &str, trim: Option<&Trim>, a: AudioOpts) -> Vec<String> {
        build_ffmpeg_args(input, output, &builtin_preset(preset).unwrap(), trim, a, None, &[])
    }

    #[test]
    fn presets_match_compress_bat() {
        let p = builtin_preset("480p").unwrap();
        assert_eq!(
            (p.height, p.crf, p.maxrate.as_str(), p.bufsize.as_str(), p.level.as_str()),
            (480, 22, "2200k", "4400k", "3.1")
        );
        let p = builtin_preset("720p").unwrap();
        assert_eq!((p.height, p.crf, p.level.as_str()), (720, 20, "4.1"));
        assert!(builtin_preset("1080p").is_none());
    }

    #[test]
    fn args_match_the_script_exactly() {
        let args = args("in.mp4", "out\\in_whatsapp_360p.mp4", "360p", None, AudioOpts::default());
        let expected: Vec<String> = [
            "-y", "-i", "in.mp4",
            "-map", "0:v:0", "-map", "0:a?",
            "-vf", "scale=-2:360:flags=lanczos",
            "-c:v", "libx264", "-preset", "slow", "-profile:v", "high",
            "-level", "3.1", "-pix_fmt", "yuv420p",
            "-crf", "24", "-maxrate", "1200k", "-bufsize", "2400k",
            "-g", "120", "-keyint_min", "60", "-sc_threshold", "40",
            "-bf", "3", "-refs", "4", "-rc-lookahead", "40",
            "-x264-params", "aq-mode=3:aq-strength=0.8",
            "-c:a", "aac", "-q:a", "2", "-ar", "48000", "-ac", "2",
            "-movflags", "+faststart",
            "-progress", "pipe:1", "-nostats",
            "out\\in_whatsapp_360p.mp4",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(args, expected);
    }

    #[test]
    fn trim_adds_input_seek_and_duration() {
        let a = args("in.mkv", "out.mp4", "480p", Some(&Trim { start: 5.5, end: 12.0 }), AudioOpts::default());
        let i = a.iter().position(|x| x == "-i").unwrap();
        assert_eq!(&a[i - 2..i + 2], &["-ss", "5.500", "-i", "in.mkv"]);
        assert_eq!(&a[i + 2..i + 4], &["-t", "6.500"]);
    }

    #[test]
    fn mute_drops_the_audio_track() {
        let a = args("in.mp4", "out.mp4", "480p", None, audio(Some("mute")));
        assert!(a.contains(&"-an".to_string()));
        assert!(!a.contains(&"0:a?".to_string()));
        assert!(!a.contains(&"-c:a".to_string()));
    }

    #[test]
    fn volume_reduction_adds_filter_and_keeps_aac() {
        let a = args("in.mp4", "out.mp4", "480p", None, audio(Some("50")));
        let i = a.iter().position(|x| x == "-af").unwrap();
        assert_eq!(a[i + 1], "volume=0.5");
        assert!(a.contains(&"-c:a".to_string()));
        let a = args("in.mp4", "out.mp4", "480p", None, audio(Some("banana")));
        assert!(!a.iter().any(|x| x == "-af"));
        assert!(a.contains(&"0:a?".to_string()));
    }

    #[test]
    fn track_selection_maps_the_chosen_stream() {
        let opts = AudioOpts { source: Some("1"), track_count: 3, ..Default::default() };
        let a = args("in.mkv", "out.mp4", "480p", None, opts);
        assert!(a.contains(&"0:a:1".to_string()));
        assert!(!a.contains(&"0:a?".to_string()));
        let opts = AudioOpts { source: Some("x1"), track_count: 3, ..Default::default() };
        let a = args("in.mkv", "out.mp4", "480p", None, opts);
        assert!(a.contains(&"0:a?".to_string()));
    }

    #[test]
    fn merge_builds_amix_graph_with_inner_chain() {
        let opts = AudioOpts { source: Some("merge"), level: Some("50"), normalize: true, track_count: 2 };
        let a = args("in.mkv", "out.mp4", "480p", None, opts);
        let i = a.iter().position(|x| x == "-filter_complex").unwrap();
        assert_eq!(
            a[i + 1],
            format!("[0:a:0][0:a:1]amix=inputs=2:duration=longest:normalize=0,{LOUDNORM},volume=0.5[aout]")
        );
        assert_eq!(&a[i + 2..i + 4], &["-map", "[aout]"]);
        assert!(!a.iter().any(|x| x == "-af"));
        let opts = AudioOpts { source: Some("merge"), track_count: 1, ..Default::default() };
        let a = args("in.mkv", "out.mp4", "480p", None, opts);
        assert!(a.contains(&"0:a?".to_string()));
        assert!(!a.iter().any(|x| x == "-filter_complex"));
    }

    #[test]
    fn normalize_alone_uses_af_loudnorm() {
        let opts = AudioOpts { normalize: true, ..Default::default() };
        let a = args("in.mp4", "out.mp4", "480p", None, opts);
        let i = a.iter().position(|x| x == "-af").unwrap();
        assert_eq!(a[i + 1], LOUDNORM);
    }

    #[test]
    fn gpu_encoders_swap_the_video_block_and_keep_the_ceiling() {
        let p = builtin_preset("720p").unwrap();
        for (enc, codec) in [("nvenc", "h264_nvenc"), ("amf", "h264_amf"), ("qsv", "h264_qsv")] {
            let a = build_ffmpeg_args("in.mp4", "out.mp4", &p, None, AudioOpts::default(), Some(enc), &[]);
            assert!(a.contains(&codec.to_string()), "{enc}");
            assert!(!a.contains(&"libx264".to_string()), "{enc}");
            assert!(!a.iter().any(|x| x == "-x264-params"), "{enc}");
            let i = a.iter().position(|x| x == "-maxrate").unwrap();
            assert_eq!(a[i + 1], "4200k", "{enc}");
            assert!(a.contains(&"-c:a".to_string()), "{enc}: audio block intact");
        }
        // Unknown encoder ids fall back to x264.
        let a = build_ffmpeg_args("in.mp4", "out.mp4", &p, None, AudioOpts::default(), Some("vhs"), &[]);
        assert!(a.contains(&"libx264".to_string()));
    }

    #[test]
    fn extra_args_land_right_before_the_output() {
        let p = builtin_preset("480p").unwrap();
        let extra = vec!["-metadata".to_string(), "title=x".to_string()];
        let a = build_ffmpeg_args("in.mp4", "out.mp4", &p, None, AudioOpts::default(), None, &extra);
        let n = a.len();
        assert_eq!(&a[n - 3..], &["-metadata", "title=x", "out.mp4"]);
        assert_eq!(a[n - 4], "-nostats");
    }

    #[test]
    fn custom_preset_names_are_slugged() {
        assert_eq!(slug("My Phone (HD)!"), "My_Phone__HD");
        assert_eq!(slug("480p"), "480p");
        assert_eq!(slug("***"), "custom");
        let p = PresetSpec::new("Story 1080", 1080, 20, "6000k", "12000k", "4.2");
        let out = output_path(Path::new("vids/clip.mkv"), &p, None, None).unwrap();
        assert_eq!(out, Path::new("vids/whatsapp_Story_1080/clip_whatsapp_Story_1080.mp4"));
    }

    #[test]
    fn output_path_default_override_and_parts() {
        let p = builtin_preset("480p").unwrap();
        let input = Path::new("vids/clip.mkv");
        assert_eq!(
            output_path(input, &p, None, None).unwrap(),
            Path::new("vids/whatsapp_480p/clip_whatsapp_480p.mp4")
        );
        assert_eq!(
            output_path(input, &p, Some("out"), None).unwrap(),
            Path::new("out/clip_whatsapp_480p.mp4")
        );
        assert_eq!(
            output_path(input, &p, None, Some(2)).unwrap(),
            Path::new("vids/whatsapp_480p/clip_whatsapp_480p_part2.mp4")
        );
    }

    #[test]
    fn unique_path_appends_a_counter() {
        let dir = std::env::temp_dir().join(format!("kecilin-unique-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let base = dir.join("clip.mp4");
        fs::write(&base, b"x").unwrap();
        fs::write(dir.join("clip_2.mp4"), b"x").unwrap();
        assert_eq!(unique_path(&base), dir.join("clip_3.mp4"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_duration_header() {
        let stderr = "Input #0, mov,mp4\n  Duration: 00:01:23.45, start: 0.000000, bitrate: 5000 kb/s\n";
        let d = parse_duration_secs(stderr).unwrap();
        assert!((d - 83.45).abs() < 1e-9);
        assert_eq!(parse_duration_secs("Duration: N/A, bitrate: N/A"), None);
        assert_eq!(parse_duration_secs("no duration here"), None);
    }

    #[test]
    fn parses_progress_lines() {
        assert_eq!(parse_progress_us("out_time_us=1500000"), Some(1_500_000));
        assert_eq!(parse_progress_us("out_time_ms=1500000"), Some(1_500_000));
        assert_eq!(parse_progress_us("out_time_us=-9223372036854775808"), Some(0));
        assert_eq!(parse_progress_us("out_time_ms=N/A"), None);
        assert_eq!(parse_progress_us("progress=end"), None);
    }

    #[test]
    fn counts_audio_streams_from_header() {
        let stderr = "Input #0, matroska\n  Duration: 00:10:00.00, start: 0.0\n    \
Stream #0:0: Video: h264 (High)\n    Stream #0:1(und): Audio: aac, 48000 Hz\n    \
Stream #0:2(und): Audio: aac, 48000 Hz\n    Stream #0:3: Subtitle: ass\n";
        assert_eq!(parse_audio_tracks(stderr), 2);
        assert_eq!(parse_audio_tracks("Stream #0:0: Video: h264"), 0);
        assert_eq!(parse_audio_tracks(""), 0);
    }

    #[test]
    fn walk_skips_output_folders_when_recursive() {
        let dir = std::env::temp_dir().join(format!("kecilin-walk-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::create_dir_all(dir.join("whatsapp_480p")).unwrap();
        fs::write(dir.join("a.mp4"), b"x").unwrap();
        fs::write(dir.join("sub/b.mkv"), b"x").unwrap();
        fs::write(dir.join("whatsapp_480p/a_whatsapp_480p.mp4"), b"x").unwrap();
        fs::write(dir.join("notes.txt"), b"x").unwrap();
        let mut flat = Vec::new();
        walk(&dir, false, &mut flat);
        assert_eq!(flat.len(), 1);
        let mut deep = Vec::new();
        walk(&dir, true, &mut deep);
        let names: Vec<_> = deep.iter().map(|f| f.1.clone()).collect();
        assert_eq!(deep.len(), 2, "{names:?}");
        assert!(names.contains(&"b.mkv".to_string()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn last_error_line_prefers_stderr_tail() {
        assert_eq!(last_error_line("a\nreal error here\n\n", Some(1)), "real error here");
        assert_eq!(last_error_line("", Some(1)), "ffmpeg exited with code Some(1)");
    }
}
