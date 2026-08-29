use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Video extensions the scanner accepts (same list as compress.bat).
const VIDEO_EXTS: [&str; 5] = ["mp4", "mov", "mkv", "avi", "webm"];

/// The three fixed presets, verbatim from compress.bat.
pub struct Preset {
    pub name: &'static str,
    pub height: u32,
    pub crf: u32,
    pub maxrate: &'static str,
    pub bufsize: &'static str,
    pub level: &'static str,
}

const PRESETS: [Preset; 3] = [
    Preset { name: "360p", height: 360, crf: 24, maxrate: "1200k", bufsize: "2400k", level: "3.1" },
    Preset { name: "480p", height: 480, crf: 22, maxrate: "2200k", bufsize: "4400k", level: "3.1" },
    Preset { name: "720p", height: 720, crf: 20, maxrate: "4200k", bufsize: "8400k", level: "4.1" },
];

fn preset_by_name(name: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.name == name)
}

#[derive(Default)]
pub struct BatchState {
    running: AtomicBool,
    cancel: AtomicBool,
    child: Mutex<Option<CommandChild>>,
}

impl BatchState {
    /// Cancel the batch: raise the flag and kill the ffmpeg child, if any.
    pub fn abort(&self) {
        self.cancel.store(true, Ordering::SeqCst);
        if let Ok(mut guard) = self.child.lock() {
            if let Some(child) = guard.take() {
                let _ = child.kill();
            }
        }
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
    error: Option<String>,
    outputs: Vec<OutputFile>,
}

#[derive(Serialize, Clone)]
struct BatchDone {
    converted: u32,
    failed: u32,
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

/// Build the exact ffmpeg invocation from compress.bat (see docs/ARCHITECTURE.md).
/// Trim adds `-ss` before `-i` (fast input seek) and `-t` after it; the
/// `-progress pipe:1 -nostats` pair only affects reporting, not the encode.
/// Audio: chain order is amix → loudnorm → volume; mute wins over everything.
pub(crate) fn build_ffmpeg_args(
    input: &str,
    output: &str,
    p: &Preset,
    trim: Option<&Trim>,
    audio: AudioOpts,
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
    let crf = p.crf.to_string();
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
    push_strs(&mut a, &[
        "-vf", &vf,
        "-c:v", "libx264", "-preset", "slow", "-profile:v", "high",
        "-level", p.level, "-pix_fmt", "yuv420p",
        "-crf", &crf, "-maxrate", p.maxrate, "-bufsize", p.bufsize,
        "-g", "120", "-keyint_min", "60", "-sc_threshold", "40",
        "-bf", "3", "-refs", "4", "-rc-lookahead", "40",
        "-x264-params", "aq-mode=3:aq-strength=0.8",
    ]);
    if mute {
        push_strs(&mut a, &["-an"]);
    } else {
        if !merge && !af.is_empty() {
            push_strs(&mut a, &["-af", &af.join(",")]);
        }
        push_strs(&mut a, &["-c:a", "aac", "-q:a", "2", "-ar", "48000", "-ac", "2"]);
    }
    push_strs(&mut a, &[
        "-movflags", "+faststart",
        "-progress", "pipe:1", "-nostats",
        output,
    ]);
    a
}

fn ffmpeg(app: &AppHandle) -> Result<tauri_plugin_shell::process::Command, String> {
    // Resolved as <exe_dir>/ffmpeg.exe — the WHOLE argument is joined onto the
    // exe dir, so it must be the bare name, not "binaries/ffmpeg" (that would
    // look for <exe_dir>/binaries/ffmpeg.exe, which exists nowhere: tauri-build
    // and the bundler both lay the sidecar flat next to the app exe).
    app.shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("ffmpeg sidecar unavailable: {e} (run scripts/fetch-binaries.ps1)"))
}

/// Sidecar self-check: run `ffmpeg -version`, return the banner line.
#[tauri::command]
pub async fn check_ffmpeg(app: AppHandle) -> Result<String, String> {
    let out = ffmpeg(&app)?
        .args(["-version"])
        .output()
        .await
        .map_err(|e| {
            format!("ffmpeg failed to start: {e}. Run scripts/fetch-binaries.ps1 (dev) or reinstall Kecilin.")
        })?;
    if !out.status.success() {
        return Err(format!("ffmpeg self-check failed (exit {:?})", out.status.code()));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    Ok(stdout.lines().next().unwrap_or("ffmpeg").to_string())
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

/// List videos at the top level of `path` (non-recursive, same as the script).
#[tauri::command]
pub async fn scan_directory(app: AppHandle, path: String) -> Result<Vec<VideoFile>, String> {
    let mut found: Vec<(PathBuf, String, u64)> = Vec::new();
    for entry in fs::read_dir(&path).map_err(|e| format!("cannot read folder: {e}"))? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let p = entry.path();
        // Non-UTF-8 paths can't cross the IPC/argument boundary; skip them.
        if !p.is_file() || !is_video(&p) || p.to_str().is_none() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        found.push((p, name, size));
    }
    found.sort_by(|a, b| a.1.to_lowercase().cmp(&b.1.to_lowercase()));
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

/// Kick off a sequential batch conversion. Returns immediately; progress and
/// completion arrive as `file:*` / `batch:done` events.
#[tauri::command]
pub fn start_batch(
    app: AppHandle,
    state: State<'_, BatchState>,
    items: Vec<BatchItem>,
    preset: String,
    out_dir: Option<String>,
) -> Result<(), String> {
    let p = preset_by_name(&preset).ok_or_else(|| format!("unknown preset: {preset}"))?;
    if items.is_empty() {
        return Err("nothing to convert".into());
    }
    if state.running.swap(true, Ordering::SeqCst) {
        return Err("a batch is already running".into());
    }
    state.cancel.store(false, Ordering::SeqCst);
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move { run_batch(app2, items, p, out_dir).await });
    Ok(())
}

#[tauri::command]
pub fn cancel_batch(state: State<'_, BatchState>) {
    state.abort();
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
    let p = preset_by_name(&preset).ok_or_else(|| format!("unknown preset: {preset}"))?;
    let dir = match out_dir {
        Some(d) => PathBuf::from(d),
        None => Path::new(&anchor)
            .parent()
            .ok_or("no parent folder")?
            .join(format!("whatsapp_{}", p.name)),
    };
    tauri_plugin_opener::open_path(dir, None::<&str>).map_err(|e| e.to_string())
}

async fn run_batch(
    app: AppHandle,
    items: Vec<BatchItem>,
    preset: &'static Preset,
    out_dir: Option<String>,
) {
    let mut converted = 0u32;
    let mut failed = 0u32;
    for (index, item) in items.iter().enumerate() {
        if app.state::<BatchState>().cancel.load(Ordering::SeqCst) {
            break;
        }
        let _ = app.emit("file:start", FileStart { index });
        match convert_one(&app, item, preset, out_dir.as_deref(), index).await {
            Ok(outputs) => {
                converted += 1;
                let _ = app.emit("file:done", FileDone { index, ok: true, error: None, outputs });
            }
            Err(e) => {
                // A cancel kills the child mid-file; that's not a real failure.
                if app.state::<BatchState>().cancel.load(Ordering::SeqCst) {
                    break;
                }
                failed += 1;
                let _ = app.emit(
                    "file:done",
                    FileDone { index, ok: false, error: Some(e), outputs: vec![] },
                );
            }
        }
    }
    let state = app.state::<BatchState>();
    let canceled = state.cancel.swap(false, Ordering::SeqCst);
    state.running.store(false, Ordering::SeqCst);
    let _ = app.emit("batch:done", BatchDone { converted, failed, canceled });

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

/// Where a converted file lands: inside the custom output dir if set, else in
/// `whatsapp_{preset}` next to the input (the script's layout). `part` appends
/// `_partN` for multi-part splits.
pub(crate) fn output_path(
    input: &Path,
    preset: &Preset,
    out_dir: Option<&str>,
    part: Option<usize>,
) -> Option<PathBuf> {
    let stem = input.file_stem()?.to_string_lossy();
    let dir = match out_dir {
        Some(d) => PathBuf::from(d),
        None => input.parent()?.join(format!("whatsapp_{}", preset.name)),
    };
    let suffix = part.map(|n| format!("_part{n}")).unwrap_or_default();
    Some(dir.join(format!("{}_whatsapp_{}{}.mp4", stem, preset.name, suffix)))
}

/// Convert one queue item: a single encode for the whole file or one trim
/// range, or several sequential encodes for a multi-part split. Returns the
/// produced output files (path + size) for the result stats.
async fn convert_one(
    app: &AppHandle,
    item: &BatchItem,
    preset: &Preset,
    out_dir: Option<&str>,
    index: usize,
) -> Result<Vec<OutputFile>, String> {
    let seg_count = item.trims.len().max(1);
    let mut outputs = Vec::with_capacity(seg_count);
    for seg_idx in 0..seg_count {
        let trim = item.trims.get(seg_idx);
        let part = if item.trims.len() > 1 { Some(seg_idx + 1) } else { None };
        let out = convert_segment(app, item, preset, out_dir, index, trim, part, seg_idx, seg_count)
            .await
            .map_err(|e| match part {
                Some(n) => format!("part {n}: {e}"),
                None => e,
            })?;
        outputs.push(out);
    }
    Ok(outputs)
}

#[allow(clippy::too_many_arguments)]
async fn convert_segment(
    app: &AppHandle,
    item: &BatchItem,
    preset: &Preset,
    out_dir: Option<&str>,
    index: usize,
    trim: Option<&Trim>,
    part: Option<usize>,
    seg_idx: usize,
    seg_count: usize,
) -> Result<OutputFile, String> {
    let input = Path::new(&item.path);
    let out_path =
        output_path(input, preset, out_dir, part).ok_or("file has no name or parent")?;
    let dir = out_path.parent().ok_or("output has no parent folder")?;
    fs::create_dir_all(dir).map_err(|e| format!("cannot create output folder: {e}"))?;
    let out_str = out_path.to_str().ok_or("output path is not valid UTF-8")?.to_string();

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
    let args = build_ffmpeg_args(&item.path, &out_str, preset, trim, audio);
    let (mut rx, child) = ffmpeg(app)?.args(args).spawn().map_err(|e| e.to_string())?;

    let state = app.state::<BatchState>();
    *state.child.lock().map_err(|e| e.to_string())? = Some(child);

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
    if let Ok(mut guard) = state.child.lock() {
        guard.take();
    }

    if code == Some(0) && out_path.exists() {
        let size = fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
        Ok(OutputFile { path: out_str, size })
    } else {
        // Don't leave a corrupt partial file that looks converted.
        let _ = fs::remove_file(&out_path);
        Err(last_error_line(&stderr_tail, code))
    }
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

fn last_error_line(stderr: &str, code: Option<i32>) -> String {
    stderr
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| l.to_string())
        .unwrap_or_else(|| format!("ffmpeg exited with code {code:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_match_compress_bat() {
        let p = preset_by_name("480p").unwrap();
        assert_eq!((p.height, p.crf, p.maxrate, p.bufsize, p.level), (480, 22, "2200k", "4400k", "3.1"));
        let p = preset_by_name("720p").unwrap();
        assert_eq!((p.height, p.crf, p.level), (720, 20, "4.1"));
        assert!(preset_by_name("1080p").is_none());
    }

    #[test]
    fn args_match_the_script_exactly() {
        let p = preset_by_name("360p").unwrap();
        let args =
            build_ffmpeg_args("in.mp4", "out\\in_whatsapp_360p.mp4", p, None, AudioOpts::default());
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
        let p = preset_by_name("480p").unwrap();
        let args = build_ffmpeg_args(
            "in.mkv",
            "out.mp4",
            p,
            Some(&Trim { start: 5.5, end: 12.0 }),
            AudioOpts::default(),
        );
        let i = args.iter().position(|a| a == "-i").unwrap();
        assert_eq!(&args[i - 2..i + 2], &["-ss", "5.500", "-i", "in.mkv"]);
        assert_eq!(&args[i + 2..i + 4], &["-t", "6.500"]);
    }

    fn audio(level: Option<&'static str>) -> AudioOpts<'static> {
        AudioOpts { level, ..Default::default() }
    }

    #[test]
    fn mute_drops_the_audio_track() {
        let p = preset_by_name("480p").unwrap();
        let args = build_ffmpeg_args("in.mp4", "out.mp4", p, None, audio(Some("mute")));
        assert!(args.contains(&"-an".to_string()));
        assert!(!args.contains(&"0:a?".to_string()));
        assert!(!args.contains(&"-c:a".to_string()));
    }

    #[test]
    fn volume_reduction_adds_filter_and_keeps_aac() {
        let p = preset_by_name("480p").unwrap();
        let args = build_ffmpeg_args("in.mp4", "out.mp4", p, None, audio(Some("50")));
        let i = args.iter().position(|a| a == "-af").unwrap();
        assert_eq!(args[i + 1], "volume=0.5");
        assert!(args.contains(&"-c:a".to_string()));
        // Unknown values keep audio untouched.
        let args = build_ffmpeg_args("in.mp4", "out.mp4", p, None, audio(Some("banana")));
        assert!(!args.iter().any(|a| a == "-af"));
        assert!(args.contains(&"0:a?".to_string()));
    }

    #[test]
    fn track_selection_maps_the_chosen_stream() {
        let p = preset_by_name("480p").unwrap();
        let opts = AudioOpts { source: Some("1"), track_count: 3, ..Default::default() };
        let args = build_ffmpeg_args("in.mkv", "out.mp4", p, None, opts);
        assert!(args.contains(&"0:a:1".to_string()));
        assert!(!args.contains(&"0:a?".to_string()));
        // Non-numeric junk falls back to the default map.
        let opts = AudioOpts { source: Some("x1"), track_count: 3, ..Default::default() };
        let args = build_ffmpeg_args("in.mkv", "out.mp4", p, None, opts);
        assert!(args.contains(&"0:a?".to_string()));
    }

    #[test]
    fn merge_builds_amix_graph_with_inner_chain() {
        let p = preset_by_name("480p").unwrap();
        let opts = AudioOpts {
            source: Some("merge"),
            level: Some("50"),
            normalize: true,
            track_count: 2,
        };
        let args = build_ffmpeg_args("in.mkv", "out.mp4", p, None, opts);
        let i = args.iter().position(|a| a == "-filter_complex").unwrap();
        assert_eq!(
            args[i + 1],
            format!("[0:a:0][0:a:1]amix=inputs=2:duration=longest:normalize=0,{LOUDNORM},volume=0.5[aout]")
        );
        assert_eq!(&args[i + 2..i + 4], &["-map", "[aout]"]);
        // Filters live inside the graph — no separate -af.
        assert!(!args.iter().any(|a| a == "-af"));
        // A single-track "merge" degrades to the default map.
        let opts = AudioOpts { source: Some("merge"), track_count: 1, ..Default::default() };
        let args = build_ffmpeg_args("in.mkv", "out.mp4", p, None, opts);
        assert!(args.contains(&"0:a?".to_string()));
        assert!(!args.iter().any(|a| a == "-filter_complex"));
    }

    #[test]
    fn normalize_alone_uses_af_loudnorm() {
        let p = preset_by_name("480p").unwrap();
        let opts = AudioOpts { normalize: true, ..Default::default() };
        let args = build_ffmpeg_args("in.mp4", "out.mp4", p, None, opts);
        let i = args.iter().position(|a| a == "-af").unwrap();
        assert_eq!(args[i + 1], LOUDNORM);
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
        // out_time_ms is microseconds too (ffmpeg quirk).
        assert_eq!(parse_progress_us("out_time_ms=1500000"), Some(1_500_000));
        assert_eq!(parse_progress_us("out_time_us=-9223372036854775808"), Some(0));
        assert_eq!(parse_progress_us("out_time_ms=N/A"), None);
        assert_eq!(parse_progress_us("progress=end"), None);
    }

    #[test]
    fn output_path_default_override_and_parts() {
        let p = preset_by_name("480p").unwrap();
        let input = Path::new("D:\\vids\\clip.mkv");
        assert_eq!(
            output_path(input, p, None, None).unwrap(),
            Path::new("D:\\vids\\whatsapp_480p\\clip_whatsapp_480p.mp4")
        );
        assert_eq!(
            output_path(input, p, Some("E:\\out"), None).unwrap(),
            Path::new("E:\\out\\clip_whatsapp_480p.mp4")
        );
        assert_eq!(
            output_path(input, p, None, Some(2)).unwrap(),
            Path::new("D:\\vids\\whatsapp_480p\\clip_whatsapp_480p_part2.mp4")
        );
    }

    #[test]
    fn last_error_line_prefers_stderr_tail() {
        assert_eq!(last_error_line("a\nreal error here\n\n", Some(1)), "real error here");
        assert_eq!(last_error_line("", Some(1)), "ffmpeg exited with code Some(1)");
    }
}
