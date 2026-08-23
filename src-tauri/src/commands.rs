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
pub struct VideoFile {
    path: String,
    name: String,
    size: u64,
    duration: Option<f64>,
}

#[derive(Deserialize, Clone, Copy)]
pub struct Trim {
    pub start: f64,
    pub end: f64,
}

#[derive(Deserialize, Clone)]
pub struct BatchItem {
    pub path: String,
    pub duration: Option<f64>,
    pub trim: Option<Trim>,
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
}

#[derive(Serialize, Clone)]
struct BatchDone {
    converted: u32,
    failed: u32,
    canceled: bool,
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

/// Build the exact ffmpeg invocation from compress.bat (see docs/ARCHITECTURE.md).
/// Trim adds `-ss` before `-i` (fast input seek) and `-t` after it; the
/// `-progress pipe:1 -nostats` pair only affects reporting, not the encode.
pub(crate) fn build_ffmpeg_args(
    input: &str,
    output: &str,
    p: &Preset,
    trim: Option<&Trim>,
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
    push_strs(&mut a, &[
        "-map", "0:v:0", "-map", "0:a?",
        "-vf", &vf,
        "-c:v", "libx264", "-preset", "slow", "-profile:v", "high",
        "-level", p.level, "-pix_fmt", "yuv420p",
        "-crf", &crf, "-maxrate", p.maxrate, "-bufsize", p.bufsize,
        "-g", "120", "-keyint_min", "60", "-sc_threshold", "40",
        "-bf", "3", "-refs", "4", "-rc-lookahead", "40",
        "-x264-params", "aq-mode=3:aq-strength=0.8",
        "-c:a", "aac", "-q:a", "2", "-ar", "48000", "-ac", "2",
        "-movflags", "+faststart",
        "-progress", "pipe:1", "-nostats",
        output,
    ]);
    a
}

fn ffmpeg(app: &AppHandle) -> Result<tauri_plugin_shell::process::Command, String> {
    app.shell()
        .sidecar("binaries/ffmpeg")
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

/// List videos at the top level of `path` (non-recursive, same as the script),
/// with duration parsed from ffmpeg's own header output — no ffprobe needed.
#[tauri::command]
pub async fn scan_directory(app: AppHandle, path: String) -> Result<Vec<VideoFile>, String> {
    let mut found: Vec<(PathBuf, String, u64)> = Vec::new();
    for entry in fs::read_dir(&path).map_err(|e| format!("cannot read folder: {e}"))? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let is_video = p
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| VIDEO_EXTS.contains(&e.to_ascii_lowercase().as_str()))
            .unwrap_or(false);
        // Non-UTF-8 paths can't cross the IPC/argument boundary; skip them.
        if !is_video || p.to_str().is_none() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        found.push((p, name, size));
    }
    found.sort_by(|a, b| a.1.to_lowercase().cmp(&b.1.to_lowercase()));

    let mut files = Vec::with_capacity(found.len());
    for (p, name, size) in found {
        let path_str = p.to_str().unwrap().to_string(); // UTF-8 checked above
        // ffmpeg exits non-zero without an output file; the header still prints.
        let duration = match ffmpeg(&app)?.args(["-hide_banner", "-i", &path_str]).output().await {
            Ok(out) => parse_duration_secs(&String::from_utf8_lossy(&out.stderr)),
            Err(_) => None,
        };
        files.push(VideoFile { path: path_str, name, size, duration });
    }
    Ok(files)
}

/// Kick off a sequential batch conversion. Returns immediately; progress and
/// completion arrive as `file:*` / `batch:done` events.
#[tauri::command]
pub fn start_batch(
    app: AppHandle,
    state: State<'_, BatchState>,
    items: Vec<BatchItem>,
    preset: String,
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
    tauri::async_runtime::spawn(async move { run_batch(app2, items, p).await });
    Ok(())
}

#[tauri::command]
pub fn cancel_batch(state: State<'_, BatchState>) {
    state.abort();
}

/// Open the batch output folder in the file manager.
#[tauri::command]
pub fn open_output_folder(folder: String, preset: String) -> Result<(), String> {
    let p = preset_by_name(&preset).ok_or_else(|| format!("unknown preset: {preset}"))?;
    let dir = Path::new(&folder).join(format!("whatsapp_{}", p.name));
    tauri_plugin_opener::open_path(dir, None::<&str>).map_err(|e| e.to_string())
}

async fn run_batch(app: AppHandle, items: Vec<BatchItem>, preset: &'static Preset) {
    let mut converted = 0u32;
    let mut failed = 0u32;
    for (index, item) in items.iter().enumerate() {
        if app.state::<BatchState>().cancel.load(Ordering::SeqCst) {
            break;
        }
        let _ = app.emit("file:start", FileStart { index });
        match convert_one(&app, item, preset, index).await {
            Ok(()) => {
                converted += 1;
                let _ = app.emit("file:done", FileDone { index, ok: true, error: None });
            }
            Err(e) => {
                // A cancel kills the child mid-file; that's not a real failure.
                if app.state::<BatchState>().cancel.load(Ordering::SeqCst) {
                    break;
                }
                failed += 1;
                let _ = app.emit("file:done", FileDone { index, ok: false, error: Some(e) });
            }
        }
    }
    let state = app.state::<BatchState>();
    let canceled = state.cancel.swap(false, Ordering::SeqCst);
    state.running.store(false, Ordering::SeqCst);
    let _ = app.emit("batch:done", BatchDone { converted, failed, canceled });
}

async fn convert_one(
    app: &AppHandle,
    item: &BatchItem,
    preset: &Preset,
    index: usize,
) -> Result<(), String> {
    let input = Path::new(&item.path);
    let parent = input.parent().ok_or("file has no parent folder")?;
    let stem = input.file_stem().ok_or("file has no name")?.to_string_lossy();
    let out_dir = parent.join(format!("whatsapp_{}", preset.name));
    fs::create_dir_all(&out_dir).map_err(|e| format!("cannot create output folder: {e}"))?;
    let out_path = out_dir.join(format!("{}_whatsapp_{}.mp4", stem, preset.name));
    let out_str = out_path.to_str().ok_or("output path is not valid UTF-8")?.to_string();

    // Progress denominator: the trimmed range if set, else the scanned duration.
    let denom_us: Option<f64> = item
        .trim
        .map(|t| (t.end - t.start).max(0.0))
        .or(item.duration)
        .map(|s| s * 1_000_000.0)
        .filter(|v| *v > 0.0);

    let args = build_ffmpeg_args(&item.path, &out_str, preset, item.trim.as_ref());
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
                    let percent = ((us as f64 / denom) * 100.0).clamp(0.0, 100.0);
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
        Ok(())
    } else {
        // Don't leave a corrupt partial file that looks converted.
        let _ = fs::remove_file(&out_path);
        Err(last_error_line(&stderr_tail, code))
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
        let args = build_ffmpeg_args("in.mp4", "out\\in_whatsapp_360p.mp4", p, None);
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
        let args = build_ffmpeg_args("in.mkv", "out.mp4", p, Some(&Trim { start: 5.5, end: 12.0 }));
        let i = args.iter().position(|a| a == "-i").unwrap();
        assert_eq!(&args[i - 2..i + 2], &["-ss", "5.500", "-i", "in.mkv"]);
        assert_eq!(&args[i + 2..i + 4], &["-t", "6.500"]);
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
    fn last_error_line_prefers_stderr_tail() {
        assert_eq!(last_error_line("a\nreal error here\n\n", Some(1)), "real error here");
        assert_eq!(last_error_line("", Some(1)), "ffmpeg exited with code Some(1)");
    }
}
