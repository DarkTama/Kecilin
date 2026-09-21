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

pub static PREVIEW_TASKS: std::sync::LazyLock<Mutex<HashMap<String, u32>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static PREVIEW_CHILDREN: std::sync::LazyLock<Mutex<HashMap<String, CommandChild>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static PREVIEW_CANCELLED: std::sync::LazyLock<Mutex<HashSet<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashSet::new()));

fn kill_pid(pid: u32) {
    #[cfg(windows)]
    unsafe {
        extern "system" {
            fn OpenProcess(
                dwDesiredAccess: u32,
                bInheritHandle: i32,
                dwProcessId: u32,
            ) -> *mut std::ffi::c_void;
            fn TerminateProcess(hProcess: *mut std::ffi::c_void, uExitCode: u32) -> i32;
            fn CloseHandle(hObject: *mut std::ffi::c_void) -> i32;
        }
        const PROCESS_TERMINATE: u32 = 0x0001;
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !handle.is_null() {
            TerminateProcess(handle, 1);
            CloseHandle(handle);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .output();
    }
}

pub fn abort_all_previews() {
    if let Ok(mut cancelled) = PREVIEW_CANCELLED.lock() {
        if let Ok(tasks) = PREVIEW_TASKS.lock() {
            for key in tasks.keys() {
                cancelled.insert(key.clone());
            }
        }
    }
    if let Ok(mut children) = PREVIEW_CHILDREN.lock() {
        for (_, child) in children.drain() {
            let _ = child.kill();
        }
    }
    if let Ok(mut tasks) = PREVIEW_TASKS.lock() {
        for (_, pid) in tasks.drain() {
            kill_pid(pid);
        }
    }
}

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
    #[allow(dead_code)]
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

#[allow(dead_code)]
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

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Trim {
    pub start: f64,
    pub end: f64,
    #[serde(default)]
    pub custom_name: Option<String>,
}

#[allow(dead_code)]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SpeedRange {
    pub start: f64,
    pub end: f64,
    pub speed: f64,
    pub fit_target: bool,
    pub target_duration: Option<f64>,
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
    #[serde(default)]
    #[allow(dead_code)]
    pub speed_range: Option<SpeedRange>,
    /// Several non-overlapping speed ranges inside one trim (preferred).
    #[serde(default)]
    #[allow(dead_code)]
    pub speed_ranges: Option<Vec<SpeedRange>>,
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
    #[serde(default)]
    pub low_priority: bool,
    #[serde(default)]
    pub strip_metadata: bool,
    #[serde(default)]
    pub naming_template: Option<String>,
    #[serde(default)]
    pub delete_source_to_trash: bool,
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
pub struct PreviewProgress {
    pub path: String,
    pub percent: u32,
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

/// Parse the primary video and audio codecs from ffmpeg stderr header.
pub(crate) fn parse_codecs(stderr: &str) -> (Option<String>, Option<String>) {
    let mut video = None;
    let mut audio = None;
    for line in stderr.lines() {
        if !line.contains("Stream #") {
            continue;
        }
        if video.is_none() && line.contains(": Video: ") {
            if let Some(pos) = line.find(": Video: ") {
                let rest = &line[pos + ": Video: ".len()..];
                let codec: String = rest
                    .chars()
                    .take_while(|c| !c.is_whitespace() && *c != ',' && *c != '(')
                    .collect();
                if !codec.is_empty() {
                    video = Some(codec.to_lowercase());
                }
            }
        }
        if audio.is_none() && line.contains(": Audio: ") {
            if let Some(pos) = line.find(": Audio: ") {
                let rest = &line[pos + ": Audio: ".len()..];
                let codec: String = rest
                    .chars()
                    .take_while(|c| !c.is_whitespace() && *c != ',' && *c != '(')
                    .collect();
                if !codec.is_empty() {
                    audio = Some(codec.to_lowercase());
                }
            }
        }
    }
    (video, audio)
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
    strip_metadata: bool,
    speed_ranges: &[SpeedRange],
    duration: Option<f64>,
) -> Vec<String> {
    let t_start = trim.map(|t| t.start).unwrap_or(0.0);
    let t_end = trim.map(|t| t.end).or(duration);
    let normalized = normalize_speed_ranges(speed_ranges, t_start, t_end);
    let is_speed_active = !normalized.is_empty();
    let mute = audio.level == Some("mute");

    let mut a: Vec<String> = vec!["-y".into()];
    if let Some(t) = trim {
        if !is_speed_active {
            push_strs(&mut a, &["-ss", &format!("{:.3}", t.start)]);
        }
    }
    push_strs(&mut a, &["-i", input]);
    if let Some(t) = trim {
        if !is_speed_active {
            push_strs(&mut a, &["-t", &format!("{:.3}", (t.end - t.start).max(0.0))]);
        }
    }

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

    if is_speed_active {
        let (graph, maps) = build_speed_filtergraph(
            trim,
            &normalized,
            p.height,
            !mute,
            audio.level,
            audio.normalize,
            duration,
        );
        push_strs(&mut a, &["-filter_complex", &graph]);
        for m in maps {
            a.push(m);
        }
    } else {
        let vf = format!("scale=-2:{}:flags=lanczos", p.height);
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
    }

    a.extend(video_args(p, encoder));
    if mute {
        push_strs(&mut a, &["-an"]);
    } else {
        if !is_speed_active && !merge && !af.is_empty() {
            push_strs(&mut a, &["-af", &af.join(",")]);
        }
        push_strs(&mut a, &["-c:a", "aac", "-q:a", "2", "-ar", "48000", "-ac", "2"]);
    }
    push_strs(&mut a, &["-movflags", "+faststart", "-progress", "pipe:1", "-nostats"]);
    if strip_metadata {
        push_strs(&mut a, &["-map_metadata", "-1"]);
    }
    a.extend(extra.iter().cloned());
    a.push(output.to_string());
    a
}

/// atempo accepts 0.5–2.0 per instance; chain factors to cover any speed.
pub(crate) fn build_atempo_chain(speed: f64) -> String {
    if speed <= 0.0 {
        return "atempo=1.0".into();
    }
    let mut factors = Vec::new();
    let mut rem = speed;
    while rem > 2.0 {
        factors.push(2.0);
        rem /= 2.0;
    }
    while rem < 0.5 && rem > 0.0 {
        factors.push(0.5);
        rem /= 0.5;
    }
    factors.push((rem * 1000.0).round() / 1000.0);
    factors
        .iter()
        .map(|f| format!("atempo={:.3}", f))
        .collect::<Vec<_>>()
        .join(",")
}

/// Clamp speed ranges into the trim, drop no-op ones, sort and de-overlap.
/// Result is strictly ascending and non-overlapping.
pub(crate) fn normalize_speed_ranges(
    ranges: &[SpeedRange],
    t_start: f64,
    t_end: Option<f64>,
) -> Vec<SpeedRange> {
    let mut clamped: Vec<SpeedRange> = Vec::new();
    for r in ranges {
        if !r.speed.is_finite() || r.speed <= 1.0 || !r.start.is_finite() || !r.end.is_finite() {
            continue;
        }
        let s_start = match t_end {
            Some(te) => t_start.max(te.min(r.start)),
            None => t_start.max(r.start),
        };
        let s_end = match t_end {
            Some(te) => s_start.max(te.min(r.end)),
            None => s_start.max(r.end),
        };
        if s_end <= s_start + 0.05 {
            continue;
        }
        let mut c = r.clone();
        c.start = s_start;
        c.end = s_end;
        clamped.push(c);
    }
    clamped.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal));

    let mut out: Vec<SpeedRange> = Vec::new();
    for mut r in clamped {
        if let Some(prev) = out.last() {
            if r.start < prev.end {
                r.start = prev.end;
            }
        }
        if r.end <= r.start + 0.05 {
            continue;
        }
        out.push(r);
    }
    out
}

/// Ranges the UI asked for: the new plural field wins, the legacy singular
/// field stays supported for older payloads.
pub(crate) fn effective_speed_ranges(item: &BatchItem) -> Vec<SpeedRange> {
    if let Some(rs) = item.speed_ranges.as_ref() {
        if !rs.is_empty() {
            return rs.clone();
        }
    }
    item.speed_range.as_ref().map(|r| vec![r.clone()]).unwrap_or_default()
}

/// Speed-ramp filtergraph: trim → alternating normal / sped segments →
/// concat → scale, mirroring `buildSpeedFiltergraph` in `src/engine/args.ts`.
pub(crate) fn build_speed_filtergraph(
    trim: Option<&Trim>,
    speed_ranges: &[SpeedRange],
    height: u32,
    has_audio: bool,
    audio_level: Option<&str>,
    normalize: bool,
    duration: Option<f64>,
) -> (String, Vec<String>) {
    let t_start = trim.map(|t| t.start).unwrap_or(0.0);
    let t_end = trim.map(|t| t.end).or(duration);

    let ranges = normalize_speed_ranges(speed_ranges, t_start, t_end);

    let mut chains: Vec<String> = Vec::new();
    let mut seg_labels: Vec<(String, Option<String>)> = Vec::new();
    let fmt = |n: f64| -> String { format!("{:.3}", n) };

    // Emit one segment: video chain always, audio chain when the track is kept.
    let emit = |chains: &mut Vec<String>,
                seg_labels: &mut Vec<(String, Option<String>)>,
                v_filters: String,
                a_filters: String| {
        let idx = seg_labels.len();
        let v_label = format!("v{idx}");
        chains.push(format!("[0:v]{v_filters}[{v_label}]"));
        if has_audio {
            let a_label = format!("a{idx}");
            chains.push(format!("[0:a]{a_filters}[{a_label}]"));
            seg_labels.push((v_label, Some(a_label)));
        } else {
            seg_labels.push((v_label, None));
        }
    };

    let mut cursor = t_start;
    for r in &ranges {
        // Normal gap before this range (head gap included).
        if r.start > cursor + 0.001 {
            emit(
                &mut chains,
                &mut seg_labels,
                format!("trim=start={}:end={},setpts=PTS-STARTPTS", fmt(cursor), fmt(r.start)),
                format!("atrim=start={}:end={},asetpts=PTS-STARTPTS", fmt(cursor), fmt(r.start)),
            );
        }
        // Sped segment.
        let atempo = build_atempo_chain(r.speed);
        emit(
            &mut chains,
            &mut seg_labels,
            format!(
                "trim=start={}:end={},setpts=PTS-STARTPTS,setpts=PTS/{:.3}",
                fmt(r.start),
                fmt(r.end),
                r.speed
            ),
            format!(
                "atrim=start={}:end={},asetpts=PTS-STARTPTS,{atempo}",
                fmt(r.start),
                fmt(r.end)
            ),
        );
        cursor = r.end;
    }

    // Tail segment after the last range.
    match t_end {
        Some(te) => {
            if cursor < te - 0.001 {
                emit(
                    &mut chains,
                    &mut seg_labels,
                    format!("trim=start={}:end={},setpts=PTS-STARTPTS", fmt(cursor), fmt(te)),
                    format!("atrim=start={}:end={},asetpts=PTS-STARTPTS", fmt(cursor), fmt(te)),
                );
            }
        }
        None => {
            emit(
                &mut chains,
                &mut seg_labels,
                format!("trim=start={},setpts=PTS-STARTPTS", fmt(cursor)),
                format!("atrim=start={},asetpts=PTS-STARTPTS", fmt(cursor)),
            );
        }
    }

    let count = seg_labels.len();
    let mut concat_inputs = String::new();
    for (v, a) in &seg_labels {
        concat_inputs.push_str(&format!("[{v}]"));
        if has_audio {
            if let Some(a_label) = a {
                concat_inputs.push_str(&format!("[{a_label}]"));
            }
        }
    }

    let concat_filter = format!(
        "{concat_inputs}concat=n={count}:v=1:a={}[vcat]{}",
        if has_audio { 1 } else { 0 },
        if has_audio { "[acat]" } else { "" }
    );
    chains.push(concat_filter);

    // Video scale
    chains.push(format!("[vcat]scale=-2:{height}:flags=lanczos[vout]"));

    let mut audio_out_label = "[acat]".to_string();
    if has_audio {
        let mut af = Vec::new();
        if normalize {
            af.push(LOUDNORM.to_string());
        }
        match audio_level {
            Some("75") => af.push("volume=0.75".into()),
            Some("50") => af.push("volume=0.5".into()),
            Some("25") => af.push("volume=0.25".into()),
            _ => {}
        }
        if !af.is_empty() {
            chains.push(format!("[acat]{}[aout]", af.join(",")));
            audio_out_label = "[aout]".to_string();
        }
    }

    let mut map_args = vec!["-map".to_string(), "[vout]".to_string()];
    if has_audio {
        map_args.push("-map".to_string());
        map_args.push(audio_out_label);
    }

    (chains.join(";"), map_args)
}

#[allow(dead_code)]
pub(crate) fn build_args(
    input: &str,
    output: &str,
    p: &PresetSpec,
    trim: Option<&Trim>,
    audio: AudioOpts,
    encoder: Option<&str>,
    extra: &[String],
    strip_metadata: bool,
) -> Vec<String> {
    build_ffmpeg_args(
        input,
        output,
        p,
        trim,
        audio,
        encoder,
        extra,
        strip_metadata,
        &[],
        None,
    )
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

/// Re-encode a small H.264/AAC proxy or remux so the webview can preview formats it
/// can't decode natively (HEVC, .mkv, .avi, …).
#[tauri::command]
pub async fn prepare_preview(app: AppHandle, path: String) -> Result<String, String> {
    let out = cache_file(&app, "previews", &path, "mp4")?;
    let out_str = out.to_str().ok_or("cache path is not valid UTF-8")?.to_string();
    if out.exists() {
        let _ = app.emit(
            "preview-progress",
            PreviewProgress {
                path: path.clone(),
                percent: 100,
            },
        );
        return Ok(out_str);
    }

    if let Ok(mut cancelled) = PREVIEW_CANCELLED.lock() {
        cancelled.remove(&path);
    }

    // Probe duration and stream codecs from ffmpeg header
    let probe_out = ffmpeg(&app)?
        .args(["-hide_banner", "-i", &path])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let probe_stderr = String::from_utf8_lossy(&probe_out.stderr);
    let duration = parse_duration_secs(&probe_stderr);
    let (video_codec, audio_codec) = parse_codecs(&probe_stderr);

    // If video is h264 and audio is aac or absent: instant stream copy remux (<1s)
    let can_remux = video_codec.as_deref() == Some("h264")
        && (audio_codec.is_none() || audio_codec.as_deref() == Some("aac"));

    if PREVIEW_CANCELLED.lock().map(|s| s.contains(&path)).unwrap_or(false) {
        let _ = fs::remove_file(&out);
        return Err("preview cancelled".into());
    }

    if can_remux {
        let (mut rx, child) = ffmpeg(&app)?
            .args([
                "-y", "-i", &path, "-map", "0:v:0", "-map", "0:a?", "-sn", "-dn",
                "-c", "copy", "-movflags", "+faststart", &out_str,
            ])
            .spawn()
            .map_err(|e| e.to_string())?;

        let pid = child.pid();
        if let Ok(mut tasks) = PREVIEW_TASKS.lock() {
            tasks.insert(path.clone(), pid);
        }
        if let Ok(mut children) = PREVIEW_CHILDREN.lock() {
            children.insert(path.clone(), child);
        }

        let mut code: Option<i32> = None;
        while let Some(ev) = rx.recv().await {
            if let CommandEvent::Terminated(t) = ev {
                code = t.code;
            }
        }

        if let Ok(mut tasks) = PREVIEW_TASKS.lock() {
            tasks.remove(&path);
        }
        if let Ok(mut children) = PREVIEW_CHILDREN.lock() {
            children.remove(&path);
        }

        let user_cancelled = PREVIEW_CANCELLED
            .lock()
            .map(|mut s| s.remove(&path))
            .unwrap_or(false);

        if user_cancelled {
            let _ = fs::remove_file(&out);
            return Err("preview cancelled".into());
        }

        if code == Some(0) && out.exists() {
            let _ = app.emit(
                "preview-progress",
                PreviewProgress {
                    path: path.clone(),
                    percent: 100,
                },
            );
            return Ok(out_str);
        }

        let _ = fs::remove_file(&out);
    }

    // Transcode required (HEVC, AV1, VP9, non-AAC audio, etc.)
    if PREVIEW_CANCELLED.lock().map(|s| s.contains(&path)).unwrap_or(false) {
        let _ = fs::remove_file(&out);
        return Err("preview cancelled".into());
    }

    let (mut rx, child) = ffmpeg(&app)?
        .args([
            "-y",
            "-hwaccel", "auto",
            "-i", &path,
            "-map", "0:v:0",
            "-map", "0:a?",
            "-sn",
            "-dn",
            "-vf", "scale=-2:360",
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "28",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-ac", "2",
            "-ar", "48000",
            "-movflags", "+faststart",
            "-progress", "pipe:1",
            &out_str,
        ])
        .spawn()
        .map_err(|e| e.to_string())?;

    let pid = child.pid();
    if let Ok(mut tasks) = PREVIEW_TASKS.lock() {
        tasks.insert(path.clone(), pid);
    }
    if let Ok(mut children) = PREVIEW_CHILDREN.lock() {
        children.insert(path.clone(), child);
    }

    let denom_us = duration.map(|d| (d * 1_000_000.0) as u64);
    let mut stderr_tail = String::new();
    let mut code: Option<i32> = None;
    let mut last_pct: Option<u32> = None;
    let mut last_emit = Instant::now() - Duration::from_secs(1);

    while let Some(ev) = rx.recv().await {
        match ev {
            CommandEvent::Stdout(bytes) => {
                let text = String::from_utf8_lossy(&bytes);
                for line in text.lines() {
                    if let Some(us) = parse_progress_us(line) {
                        if let Some(denom) = denom_us {
                            if denom > 0 {
                                let pct = (((us as f64) / (denom as f64)) * 100.0).clamp(0.0, 100.0) as u32;
                                if last_pct != Some(pct) && (last_emit.elapsed() >= Duration::from_millis(150) || pct == 100) {
                                    last_pct = Some(pct);
                                    last_emit = Instant::now();
                                    let _ = app.emit(
                                        "preview-progress",
                                        PreviewProgress {
                                            path: path.clone(),
                                            percent: pct,
                                        },
                                    );
                                }
                            }
                        }
                    }
                }
            }
            CommandEvent::Stderr(bytes) => {
                stderr_tail.push_str(&String::from_utf8_lossy(&bytes));
                stderr_tail.push('\n');
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

    if let Ok(mut tasks) = PREVIEW_TASKS.lock() {
        tasks.remove(&path);
    }
    if let Ok(mut children) = PREVIEW_CHILDREN.lock() {
        children.remove(&path);
    }

    let user_cancelled = PREVIEW_CANCELLED
        .lock()
        .map(|mut s| s.remove(&path))
        .unwrap_or(false);

    if user_cancelled {
        let _ = fs::remove_file(&out);
        return Err("preview cancelled".into());
    }

    if code != Some(0) || !out.exists() {
        let _ = fs::remove_file(&out);
        return Err(last_error_line(&stderr_tail, code));
    }

    let _ = app.emit(
        "preview-progress",
        PreviewProgress {
            path: path.clone(),
            percent: 100,
        },
    );
    Ok(out_str)
}

#[tauri::command]
pub async fn cancel_preview(app: AppHandle, path: String) -> Result<(), String> {
    if let Ok(mut cancelled) = PREVIEW_CANCELLED.lock() {
        cancelled.insert(path.clone());
    }
    if let Ok(mut children) = PREVIEW_CHILDREN.lock() {
        if let Some(child) = children.remove(&path) {
            let _ = child.kill();
        }
    }
    if let Ok(mut tasks) = PREVIEW_TASKS.lock() {
        if let Some(pid) = tasks.remove(&path) {
            kill_pid(pid);
        }
    }
    if let Ok(out) = cache_file(&app, "previews", &path, "mp4") {
        let _ = fs::remove_file(&out);
    }
    Ok(())
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

/// Replaces any character in [\\/:*?"<>|] with _.
/// Trims leading and trailing whitespace and periods.
pub(crate) fn sanitize_filename(name: &str) -> String {
    let sanitized: String = name
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            other => other,
        })
        .collect();
    sanitized.trim_matches(|c: char| c.is_whitespace() || c == '.').to_string()
}

pub(crate) fn days_to_ymd(days: i64) -> String {
    let z = days + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}{:02}{:02}", y, m, d)
}

pub(crate) fn current_date_ymd() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    days_to_ymd((secs / 86400) as i64)
}
fn extract_stem(stem_or_path: &str) -> &str {
    for ext in &VIDEO_EXTS {
        let dot_ext_len = ext.len() + 1;
        if stem_or_path.len() > dot_ext_len
            && stem_or_path.is_char_boundary(stem_or_path.len() - dot_ext_len)
            && stem_or_path[stem_or_path.len() - dot_ext_len..].eq_ignore_ascii_case(&format!(".{ext}"))
        {
            let base = &stem_or_path[..stem_or_path.len() - dot_ext_len];
            return Path::new(base).file_name().and_then(|n| n.to_str()).unwrap_or(base);
        }
    }
    Path::new(stem_or_path).file_name().and_then(|n| n.to_str()).unwrap_or(stem_or_path)
}

/// Computes output filename respecting custom names and naming templates.
pub(crate) fn output_filename(
    stem_or_path: &str,
    preset: &PresetSpec,
    part: Option<usize>,
    template: Option<&str>,
    trim: Option<&Trim>,
) -> String {
    output_filename_internal(stem_or_path, preset, part, template, trim, None)
}

pub(crate) fn output_filename_internal(
    stem_or_path: &str,
    preset: &PresetSpec,
    part: Option<usize>,
    template: Option<&str>,
    trim: Option<&Trim>,
    date_override: Option<&str>,
) -> String {
    // 1. If trim has custom_name that is non-empty:
    //    Sanitize characters [\\/:*?"<>|] to _.
    //    Ensure .mp4 extension.
    //    Use it directly.
    if let Some(custom_name) = trim.and_then(|t| t.custom_name.as_deref()) {
        let trimmed = custom_name.trim();
        if !trimmed.is_empty() {
            let sanitized = sanitize_filename(trimmed);
            if !sanitized.is_empty() {
                return if sanitized.len() >= 4
                    && sanitized.is_char_boundary(sanitized.len() - 4)
                    && sanitized[sanitized.len() - 4..].eq_ignore_ascii_case(".mp4")
                {
                    sanitized
                } else {
                    format!("{sanitized}.mp4")
                };
            }
        }
    }

    let stem = extract_stem(stem_or_path);

    // 2. Otherwise, if opts.naming_template is provided, substitute tokens {name}, {stem}, {preset}, {part}, {resolution}, {date}.
    if let Some(tmpl) = template.map(str::trim).filter(|s| !s.is_empty()) {
        let pattern_had_part = tmpl.to_lowercase().contains("{part}");
        let date_str = match date_override {
            Some(d) => d.to_string(),
            None => current_date_ymd(),
        };
        let tag = slug(&preset.name);
        let part_str = match part {
            Some(n) if n > 0 => format!("_part{n}"),
            _ => String::new(),
        };
        let resolution_str = if preset.height > 0 {
            format!("{}p", preset.height)
        } else {
            preset.name.clone()
        };

        let mut resolved = tmpl.to_string();
        let tokens = [
            ("{name}", stem),
            ("{stem}", stem),
            ("{preset}", &tag),
            ("{part}", &part_str),
            ("{resolution}", &resolution_str),
            ("{date}", &date_str),
        ];
        for (tok, val) in tokens {
            let tok_len = tok.len();
            let mut result = String::with_capacity(resolved.len());
            let mut remaining = resolved.as_str();
            while !remaining.is_empty() {
                if remaining.len() >= tok_len
                    && remaining.is_char_boundary(tok_len)
                    && remaining[..tok_len].eq_ignore_ascii_case(tok)
                {
                    result.push_str(val);
                    remaining = &remaining[tok_len..];
                } else {
                    let mut chars = remaining.chars();
                    if let Some(c) = chars.next() {
                        result.push(c);
                        remaining = chars.as_str();
                    }
                }
            }
            resolved = result;
        }

        if resolved.len() >= 4
            && resolved.is_char_boundary(resolved.len() - 4)
            && resolved[resolved.len() - 4..].eq_ignore_ascii_case(".mp4")
        {
            resolved.truncate(resolved.len() - 4);
        }
        let mut sanitized = sanitize_filename(&resolved);

        // Auto-append _part suffix when multi-part is missing {part} token
        if let Some(n) = part {
            if n > 0 && !pattern_had_part && !sanitized.ends_with(&format!("_part{n}")) {
                sanitized = format!("{sanitized}_part{n}");
            }
        }

        if sanitized.is_empty() {
            "output.mp4".to_string()
        } else {
            format!("{sanitized}.mp4")
        }
    } else {
        // 3. If no custom template is provided, preserve standard {stem}_whatsapp_{preset}[_partN].mp4
        let tag = slug(&preset.name);
        let suffix = part.map(|n| format!("_part{n}")).unwrap_or_default();
        format!("{stem}_whatsapp_{tag}{suffix}.mp4")
    }
}

/// Where a converted file lands: inside the custom output dir if set, else in
/// `whatsapp_{preset}` next to the input (the script's layout). `part` appends
/// `_partN` for multi-part splits.
#[allow(dead_code)]
pub(crate) fn output_path(
    input: &Path,
    preset: &PresetSpec,
    out_dir: Option<&str>,
    part: Option<usize>,
) -> Option<PathBuf> {
    output_path_full(input, preset, out_dir, part, None, None)
}

pub(crate) fn output_path_full(
    input: &Path,
    preset: &PresetSpec,
    out_dir: Option<&str>,
    part: Option<usize>,
    template: Option<&str>,
    trim: Option<&Trim>,
) -> Option<PathBuf> {
    let stem = input.file_stem()?.to_string_lossy();
    let tag = slug(&preset.name);
    let dir = match out_dir {
        Some(d) => PathBuf::from(d),
        None => input.parent()?.join(format!("whatsapp_{tag}")),
    };
    let filename = output_filename(&stem, preset, part, template, trim);
    Some(dir.join(filename))
}

pub(crate) fn maybe_delete_source_to_trash(
    item_path: &str,
    opts: &BatchOptions,
    outputs: &[OutputFile],
    canceled: bool,
) {
    if !opts.delete_source_to_trash || canceled || outputs.is_empty() {
        return;
    }
    let all_valid = outputs.iter().all(|o| {
        let p = Path::new(&o.path);
        p.exists() && fs::metadata(p).map(|m| m.len() > 0).unwrap_or(false)
    });
    if !all_valid {
        return;
    }

    // Guard against collision: do not delete if any output path equals source path.
    let source_path = Path::new(item_path);
    let source_canon = fs::canonicalize(source_path).ok();
    let collision = outputs.iter().any(|o| {
        let out_path = Path::new(&o.path);
        out_path == source_path
            || (source_canon.is_some() && fs::canonicalize(out_path).ok() == source_canon)
    });
    if collision {
        eprintln!(
            "Warning: skipping trash deletion because output file collides with source: {}",
            item_path
        );
        return;
    }

    if let Err(e) = trash::delete(source_path) {
        eprintln!(
            "Warning: failed to move source file {} to trash: {}",
            item_path, e
        );
    }
}

/// When launching FFmpeg in `ffmpeg_cmd()` or wherever `tokio::process::Command` is prepared:
#[cfg(target_os = "windows")]
#[allow(dead_code)]
pub fn ffmpeg_cmd(cmd: &mut std::process::Command, opts: &BatchOptions) {
    use std::os::windows::process::CommandExt;
    const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x00004000;
    if opts.low_priority {
        cmd.creation_flags(BELOW_NORMAL_PRIORITY_CLASS);
    }
}

#[cfg(not(target_os = "windows"))]
pub fn ffmpeg_cmd(_cmd: &mut std::process::Command, _opts: &BatchOptions) {}


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
                    let canceled = app2.state::<BatchState>().cancel.load(Ordering::SeqCst);
                    maybe_delete_source_to_trash(&item.path, &opts2, &outputs, canceled);
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
    let mut out_path = output_path_full(
        input,
        &opts.preset,
        opts.out_dir.as_deref(),
        part,
        opts.naming_template.as_deref(),
        trim,
    )
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
        opts.strip_metadata,
        &effective_speed_ranges(item),
        item.duration,
    );
    let (mut rx, child) = ffmpeg(app)
        .map_err(fail)?
        .args(args)
        .spawn()
        .map_err(|e| fail(e.to_string()))?;

    #[cfg(target_os = "windows")]
    if opts.low_priority {
        let pid = child.pid();
        unsafe {
            extern "system" {
                fn OpenProcess(
                    dwDesiredAccess: u32,
                    bInheritHandle: i32,
                    dwProcessId: u32,
                ) -> *mut std::ffi::c_void;
                fn SetPriorityClass(hProcess: *mut std::ffi::c_void, dwPriorityClass: u32) -> i32;
                fn CloseHandle(hObject: *mut std::ffi::c_void) -> i32;
            }
            const PROCESS_SET_INFORMATION: u32 = 0x0200;
            const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x00004000;
            let handle = OpenProcess(PROCESS_SET_INFORMATION, 0, pid);
            if !handle.is_null() {
                SetPriorityClass(handle, BELOW_NORMAL_PRIORITY_CLASS);
                CloseHandle(handle);
            }
        }
    }

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
        build_ffmpeg_args(input, output, &builtin_preset(preset).unwrap(), trim, a, None, &[], false, &[], None)
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
        let a = args("in.mkv", "out.mp4", "480p", Some(&Trim { start: 5.5, end: 12.0, custom_name: None }), AudioOpts::default());
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
            let a = build_ffmpeg_args("in.mp4", "out.mp4", &p, None, AudioOpts::default(), Some(enc), &[], false, &[], None);
            assert!(a.contains(&codec.to_string()), "{enc}");
            assert!(!a.contains(&"libx264".to_string()), "{enc}");
            assert!(!a.iter().any(|x| x == "-x264-params"), "{enc}");
            let i = a.iter().position(|x| x == "-maxrate").unwrap();
            assert_eq!(a[i + 1], "4200k", "{enc}");
            assert!(a.contains(&"-c:a".to_string()), "{enc}: audio block intact");
        }
        // Unknown encoder ids fall back to x264.
        let a = build_ffmpeg_args("in.mp4", "out.mp4", &p, None, AudioOpts::default(), Some("vhs"), &[], false, &[], None);
        assert!(a.contains(&"libx264".to_string()));
    }

    #[test]
    fn extra_args_land_right_before_the_output() {
        let p = builtin_preset("480p").unwrap();
        let extra = vec!["-metadata".to_string(), "title=x".to_string()];
        let a = build_ffmpeg_args("in.mp4", "out.mp4", &p, None, AudioOpts::default(), None, &extra, false, &[], None);
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
    #[test]
    fn metadata_stripping_appends_flag_before_output() {
        let p = builtin_preset("480p").unwrap();
        let a = build_ffmpeg_args("in.mp4", "out.mp4", &p, None, AudioOpts::default(), None, &[], true, &[], None);
        let n = a.len();
        assert_eq!(&a[n - 3..], &["-map_metadata", "-1", "out.mp4"]);
        assert_eq!(a[n - 4], "-nostats");

        let a_off = build_ffmpeg_args("in.mp4", "out.mp4", &p, None, AudioOpts::default(), None, &[], false, &[], None);
        assert!(!a_off.contains(&"-map_metadata".to_string()));
    }

    #[test]
    fn atempo_chain_splits_out_of_range_speeds() {
        assert_eq!(build_atempo_chain(1.0), "atempo=1.000");
        assert_eq!(build_atempo_chain(2.0), "atempo=2.000");
        assert_eq!(build_atempo_chain(4.0), "atempo=2.000,atempo=2.000");
        assert_eq!(build_atempo_chain(0.25), "atempo=0.500,atempo=0.500");
        assert_eq!(build_atempo_chain(0.0), "atempo=1.0");
    }

    fn mk_range(start: f64, end: f64, speed: f64) -> SpeedRange {
        SpeedRange { start, end, speed, fit_target: false, target_duration: None }
    }

    #[test]
    fn speed_filtergraph_trims_and_concats_three_segments() {
        let trim = Trim { start: 1.0, end: 10.0, custom_name: None };
        let sr = SpeedRange {
            start: 3.0,
            end: 6.0,
            speed: 2.0,
            fit_target: false,
            target_duration: None,
        };
        let (graph, maps) = build_speed_filtergraph(
            Some(&trim),
            std::slice::from_ref(&sr),
            480,
            true,
            Some("50"),
            true,
            None,
        );
        assert!(graph.contains("[0:v]trim=start=1.000:end=3.000,setpts=PTS-STARTPTS[v0]"));
        assert!(graph.contains("[0:v]trim=start=3.000:end=6.000,setpts=PTS-STARTPTS,setpts=PTS/2.000[v1]"));
        assert!(graph.contains("[0:v]trim=start=6.000:end=10.000,setpts=PTS-STARTPTS[v2]"));
        assert!(graph.contains("concat=n=3:v=1:a=1[vcat][acat]"));
        assert!(graph.contains("[vcat]scale=-2:480:flags=lanczos[vout]"));
        assert!(graph.contains(&format!("[acat]{LOUDNORM},volume=0.5[aout]")));
        assert_eq!(maps, vec!["-map", "[vout]", "-map", "[aout]"]);
    }

    #[test]
    fn single_range_graph_is_byte_identical() {
        let trim = Trim { start: 1.0, end: 10.0, custom_name: None };
        let sr = mk_range(3.0, 6.0, 2.0);
        let (graph, _) = build_speed_filtergraph(
            Some(&trim),
            std::slice::from_ref(&sr),
            480,
            true,
            Some("50"),
            true,
            None,
        );
        let expected = [
            "[0:v]trim=start=1.000:end=3.000,setpts=PTS-STARTPTS[v0]".to_string(),
            "[0:a]atrim=start=1.000:end=3.000,asetpts=PTS-STARTPTS[a0]".to_string(),
            "[0:v]trim=start=3.000:end=6.000,setpts=PTS-STARTPTS,setpts=PTS/2.000[v1]".to_string(),
            "[0:a]atrim=start=3.000:end=6.000,asetpts=PTS-STARTPTS,atempo=2.000[a1]".to_string(),
            "[0:v]trim=start=6.000:end=10.000,setpts=PTS-STARTPTS[v2]".to_string(),
            "[0:a]atrim=start=6.000:end=10.000,asetpts=PTS-STARTPTS[a2]".to_string(),
            "[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[vcat][acat]".to_string(),
            "[vcat]scale=-2:480:flags=lanczos[vout]".to_string(),
            format!("[acat]{LOUDNORM},volume=0.5[aout]"),
        ]
        .join(";");
        assert_eq!(graph, expected);
    }

    #[test]
    fn two_ranges_produce_five_segments() {
        let trim = Trim { start: 1.0, end: 20.0, custom_name: None };
        let ranges = vec![mk_range(3.0, 6.0, 2.0), mk_range(10.0, 12.0, 4.0)];
        let (graph, _) =
            build_speed_filtergraph(Some(&trim), &ranges, 480, true, None, false, None);
        assert!(graph.contains("[0:v]trim=start=1.000:end=3.000,setpts=PTS-STARTPTS[v0]"));
        assert!(graph.contains("[0:v]trim=start=3.000:end=6.000,setpts=PTS-STARTPTS,setpts=PTS/2.000[v1]"));
        assert!(graph.contains("[0:v]trim=start=6.000:end=10.000,setpts=PTS-STARTPTS[v2]"));
        assert!(graph.contains("[0:v]trim=start=10.000:end=12.000,setpts=PTS-STARTPTS,setpts=PTS/4.000[v3]"));
        assert!(graph.contains("[0:a]atrim=start=10.000:end=12.000,asetpts=PTS-STARTPTS,atempo=2.000,atempo=2.000[a3]"));
        assert!(graph.contains("[0:v]trim=start=12.000:end=20.000,setpts=PTS-STARTPTS[v4]"));
        assert!(graph.contains("concat=n=5:v=1:a=1[vcat][acat]"));
    }

    #[test]
    fn range_flush_with_trim_start_produces_four_segments() {
        let trim = Trim { start: 1.0, end: 20.0, custom_name: None };
        let ranges = vec![mk_range(1.0, 4.0, 2.0), mk_range(10.0, 12.0, 2.0)];
        let (graph, _) =
            build_speed_filtergraph(Some(&trim), &ranges, 480, true, None, false, None);
        assert!(graph.contains("[0:v]trim=start=1.000:end=4.000,setpts=PTS-STARTPTS,setpts=PTS/2.000[v0]"));
        assert!(graph.contains("[0:v]trim=start=4.000:end=10.000,setpts=PTS-STARTPTS[v1]"));
        assert!(graph.contains("[0:v]trim=start=10.000:end=12.000,setpts=PTS-STARTPTS,setpts=PTS/2.000[v2]"));
        assert!(graph.contains("[0:v]trim=start=12.000:end=20.000,setpts=PTS-STARTPTS[v3]"));
        assert!(graph.contains("concat=n=4:v=1:a=1[vcat][acat]"));
    }

    #[test]
    fn overlapping_ranges_are_normalized_to_disjoint() {
        let ranges = vec![mk_range(5.0, 10.0, 3.0), mk_range(3.0, 8.0, 2.0)];
        let out = normalize_speed_ranges(&ranges, 0.0, Some(20.0));
        assert_eq!(out.len(), 2);
        assert_eq!((out[0].start, out[0].end, out[0].speed), (3.0, 8.0, 2.0));
        assert_eq!((out[1].start, out[1].end, out[1].speed), (8.0, 10.0, 3.0));
        for w in out.windows(2) {
            assert!(w[0].end <= w[1].start);
        }
    }

    #[test]
    fn normalize_drops_slow_and_degenerate_ranges() {
        let ranges = vec![
            mk_range(1.0, 5.0, 1.0),
            mk_range(1.0, 5.0, 0.5),
            mk_range(6.0, 6.02, 2.0),
            mk_range(7.0, 9.0, f64::NAN),
            mk_range(30.0, 40.0, 2.0),
        ];
        let out = normalize_speed_ranges(&ranges, 0.0, Some(20.0));
        assert!(out.is_empty());
    }

    #[test]
    fn speedup_args_use_filtergraph_without_ss_or_to() {
        let p = builtin_preset("480p").unwrap();
        let trim = Trim { start: 1.0, end: 10.0, custom_name: None };
        let sr = SpeedRange {
            start: 3.0,
            end: 6.0,
            speed: 2.0,
            fit_target: false,
            target_duration: None,
        };
        let a = build_ffmpeg_args(
            "in.mp4",
            "out.mp4",
            &p,
            Some(&trim),
            AudioOpts::default(),
            None,
            &[],
            false,
            std::slice::from_ref(&sr),
            None,
        );
        assert!(!a.contains(&"-ss".to_string()));
        assert!(!a.contains(&"-vf".to_string()));
        assert!(a.contains(&"-filter_complex".to_string()));
        assert!(a.contains(&"[vout]".to_string()));
        assert!(a.iter().any(|s| s == "libx264"));
        // A no-op range (end == start) must fall back to the plain path.
        let flat = SpeedRange {
            start: 3.0,
            end: 3.0,
            speed: 2.0,
            fit_target: false,
            target_duration: None,
        };
        let b = build_ffmpeg_args(
            "in.mp4",
            "out.mp4",
            &p,
            Some(&trim),
            AudioOpts::default(),
            None,
            &[],
            false,
            std::slice::from_ref(&flat),
            None,
        );
        assert!(b.contains(&"-vf".to_string()));
        assert!(!b.contains(&"-filter_complex".to_string()));
    }

    #[test]
    fn empty_speed_ranges_take_the_plain_path() {
        let p = builtin_preset("480p").unwrap();
        let trim = Trim { start: 1.0, end: 10.0, custom_name: None };
        let a = build_ffmpeg_args(
            "in.mp4",
            "out.mp4",
            &p,
            Some(&trim),
            AudioOpts::default(),
            None,
            &[],
            false,
            &[],
            None,
        );
        assert!(a.contains(&"-vf".to_string()));
        assert!(a.contains(&"-ss".to_string()));
        assert!(!a.contains(&"-filter_complex".to_string()));
    }

    #[test]
    fn effective_speed_ranges_prefers_plural_field() {
        let mut item = BatchItem {
            path: "in.mp4".into(),
            duration: None,
            trims: Vec::new(),
            audio: None,
            audio_source: None,
            normalize: false,
            audio_tracks: 0,
            speed_range: Some(mk_range(1.0, 2.0, 2.0)),
            speed_ranges: None,
        };
        assert_eq!(effective_speed_ranges(&item).len(), 1);
        item.speed_ranges = Some(Vec::new());
        assert_eq!(effective_speed_ranges(&item).len(), 1);
        item.speed_ranges = Some(vec![mk_range(1.0, 2.0, 2.0), mk_range(4.0, 6.0, 3.0)]);
        assert_eq!(effective_speed_ranges(&item).len(), 2);
        item.speed_range = None;
        item.speed_ranges = None;
        assert!(effective_speed_ranges(&item).is_empty());
    }

    #[test]
    fn sanitize_filename_replaces_illegal_and_trims() {
        assert_eq!(
            sanitize_filename("foo/bar\\baz:qux*one?two\"three<four>five|six"),
            "foo_bar_baz_qux_one_two_three_four_five_six"
        );
        assert_eq!(sanitize_filename("  ...my_file.mp4...  "), "my_file.mp4");
        assert_eq!(sanitize_filename(" . foo:bar . "), "foo_bar");
    }

    #[test]
    fn naming_template_and_custom_name_parity() {
        let p = builtin_preset("480p").unwrap();
        // Default layout
        assert_eq!(
            output_filename("clip.mkv", &p, None, None, None),
            "clip_whatsapp_480p.mp4"
        );
        assert_eq!(
            output_filename("clip.mkv", &p, Some(2), None, None),
            "clip_whatsapp_480p_part2.mp4"
        );

        // Template with date, name, resolution, and part
        let tmpl = "{date}_{name}_{resolution}{part}";
        assert_eq!(
            output_filename_internal("clip", &p, Some(1), Some(tmpl), None, Some("20260920")),
            "20260920_clip_480p_part1.mp4"
        );

        // {stem} synonym
        assert_eq!(
            output_filename_internal("holiday.mkv", &p, None, Some("{stem}_{resolution}"), None, None),
            "holiday_480p.mp4"
        );

        // Custom name override directly
        let trim_custom = Trim {
            start: 0.0,
            end: 10.0,
            custom_name: Some("My Custom Highlights".into()),
        };
        assert_eq!(
            output_filename("clip", &p, None, Some(tmpl), Some(&trim_custom)),
            "My Custom Highlights.mp4"
        );

        // Sanitize illegal chars in custom name
        let trim_illegal = Trim {
            start: 0.0,
            end: 10.0,
            custom_name: Some("Cool:Clip/1".into()),
        };
        assert_eq!(
            output_filename("clip", &p, None, None, Some(&trim_illegal)),
            "Cool_Clip_1.mp4"
        );

        // Retains existing .mp4 on custom name
        let trim_mp4 = Trim {
            start: 0.0,
            end: 10.0,
            custom_name: Some("clip.mp4".into()),
        };
        assert_eq!(
            output_filename("clip", &p, None, None, Some(&trim_mp4)),
            "clip.mp4"
        );

        let trim_upper_mp4 = Trim {
            start: 0.0,
            end: 10.0,
            custom_name: Some("clip.MP4".into()),
        };
        assert_eq!(
            output_filename("clip", &p, None, None, Some(&trim_upper_mp4)),
            "clip.MP4"
        );

        // Fallback if custom name is whitespace
        let trim_empty = Trim {
            start: 0.0,
            end: 10.0,
            custom_name: Some("   ".into()),
        };
        assert_eq!(
            output_filename("clip", &p, None, None, Some(&trim_empty)),
            "clip_whatsapp_480p.mp4"
        );

        // Auto-appends _part suffix when template lacks {part}
        assert_eq!(
            output_filename("clip", &p, Some(2), Some("{name}_{preset}"), None),
            "clip_480p_part2.mp4"
        );
    }

    #[test]
    fn days_to_ymd_calculation() {
        assert_eq!(days_to_ymd(0), "19700101");
        assert_eq!(days_to_ymd(20716), "20260920");
    }

    #[test]
    fn trash_deletion_guard_logic() {
        let opts_disabled = BatchOptions {
            preset: builtin_preset("480p").unwrap(),
            out_dir: None,
            parallel: 1,
            overwrite: "overwrite".into(),
            encoder: None,
            extra_args: vec![],
            low_priority: false,
            strip_metadata: false,
            naming_template: None,
            delete_source_to_trash: false,
        };
        // When delete_source_to_trash is false, should not delete
        maybe_delete_source_to_trash("nonexistent_test_file.mp4", &opts_disabled, &[], false);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_ffmpeg_cmd_low_priority_flag() {
        let mut cmd = std::process::Command::new("cmd");
        let opts = BatchOptions {
            preset: builtin_preset("480p").unwrap(),
            out_dir: None,
            parallel: 1,
            overwrite: "overwrite".into(),
            encoder: None,
            extra_args: vec![],
            low_priority: true,
            strip_metadata: false,
            naming_template: None,
            delete_source_to_trash: false,
        };
        ffmpeg_cmd(&mut cmd, &opts);
    }
    #[test]
    fn test_unicode_stem_and_template() {
        let p = builtin_preset("480p").unwrap();
        // Non-ASCII in stem: "liburan_🌴"
        let out = output_filename("liburan_🌴", &p, None, Some("{name}_{preset}"), None);
        assert_eq!(out, "liburan_🌴_480p.mp4");

        // Non-ASCII in template: "vidéo_{name}_{resolution}"
        let out2 = output_filename("clip", &p, None, Some("vidéo_{name}_{resolution}"), None);
        assert_eq!(out2, "vidéo_clip_480p.mp4");

        // Non-ASCII in both stem, custom name, and template
        let out3 = output_filename("vacances_2026_🏖️", &p, Some(1), Some("{date}_{name}{part}"), None);
        assert!(out3.contains("vacances_2026_🏖️_part1.mp4"));
    }

    #[test]
    fn test_multi_dot_stems() {
        let p = builtin_preset("480p").unwrap();
        // Path with multiple dots: "clip.2024.final.mp4"
        let input = Path::new("vids/clip.2024.final.mp4");
        let path = output_path_full(input, &p, None, None, None, None).unwrap();
        assert_eq!(
            path,
            Path::new("vids/whatsapp_480p/clip.2024.final_whatsapp_480p.mp4")
        );

        // Direct call to output_filename with multi-dot stem
        let out = output_filename("archive.2026.09", &p, None, Some("{name}_{preset}"), None);
        assert_eq!(out, "archive.2026.09_480p.mp4");
    }

    #[test]
    fn test_trash_collision_guard() {
        let dir = std::env::temp_dir().join(format!("kecilin-trash-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let src_file = dir.join("collision.mp4");
        fs::write(&src_file, b"sample content").unwrap();

        let opts = BatchOptions {
            preset: builtin_preset("480p").unwrap(),
            out_dir: None,
            parallel: 1,
            overwrite: "overwrite".into(),
            encoder: None,
            extra_args: vec![],
            low_priority: false,
            strip_metadata: false,
            naming_template: None,
            delete_source_to_trash: true,
        };

        // Output points to same path as source -> must not delete!
        let colliding_outputs = vec![OutputFile {
            path: src_file.to_str().unwrap().to_string(),
            size: 14,
        }];
        maybe_delete_source_to_trash(src_file.to_str().unwrap(), &opts, &colliding_outputs, false);
        assert!(src_file.exists(), "Source file should NOT be deleted if output path matches source");

        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    fn test_parse_codecs_h264_aac() {
        let stderr = r#"
Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 1150 kb/s, 30 fps
Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s (default)
"#;
        let (v, a) = parse_codecs(stderr);
        assert_eq!(v.as_deref(), Some("h264"));
        assert_eq!(a.as_deref(), Some("aac"));
    }

    #[test]
    fn test_parse_codecs_hevc_opus() {
        let stderr = r#"
Stream #0:0: Video: hevc (Main), yuv420p(tv), 3840x2160, 60 fps
Stream #0:1(eng): Audio: opus, 48000 Hz, stereo, fltp
"#;
        let (v, a) = parse_codecs(stderr);
        assert_eq!(v.as_deref(), Some("hevc"));
        assert_eq!(a.as_deref(), Some("opus"));
    }

    #[test]
    fn test_parse_codecs_video_only() {
        let stderr = r#"
Stream #0:0: Video: h264, yuv420p, 1280x720, 24 fps
"#;
        let (v, a) = parse_codecs(stderr);
        assert_eq!(v.as_deref(), Some("h264"));
        assert_eq!(a, None);
    }

    #[test]
    fn test_parse_codecs_empty() {
        let (v, a) = parse_codecs("");
        assert_eq!(v, None);
        assert_eq!(a, None);
    }
}
