<#
.SYNOPSIS
  Download a pinned ffmpeg Windows build (BtbN GPL build, includes libx264) and
  install it as the Tauri sidecar: src-tauri/binaries/ffmpeg-<triple>.exe.

.DESCRIPTION
  The binary is gitignored (~160 MB zip); this script repopulates it. Runs from
  npm postinstall and from CI. Idempotent unless -Force.

  Pinned to a dated BtbN autobuild tag so the download is immutable; integrity
  is checked against a hard-coded SHA-256 (fallback: the release's
  checksums.sha256 asset).

.NOTES
  Runs on Windows PowerShell 5.1+. No Rust required. Keep this file ASCII-only.
#>
[CmdletBinding()]
param(
    [string]$Tag = "autobuild-2026-08-23-13-03",
    [string]$Asset = "ffmpeg-n8.1.2-44-g7c533d0f86-win64-gpl-8.1.zip",
    [string]$ExpectedSha256 = "",
    [switch]$Force
)
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Known-good SHA-256 hashes for pinned assets (verified at authoring time).
$KnownSha256 = @{
    "ffmpeg-n8.1.2-44-g7c533d0f86-win64-gpl-8.1.zip" = "40D98AEF3E8D48665C4DBBDD0093D6E50C61D71A3A48067E9D3EDD9FB3A1F3CA"
}
if (-not $ExpectedSha256 -and $KnownSha256.ContainsKey($Asset) -and $KnownSha256[$Asset]) {
    $ExpectedSha256 = $KnownSha256[$Asset]
}

$root   = Split-Path -Parent $PSScriptRoot
$binDir = Join-Path $root "src-tauri\binaries"

# Target triple for the sidecar suffix (Tauri requires this). Default to MSVC;
# derive from rustc if available so non-default toolchains still work.
$triple = "x86_64-pc-windows-msvc"
$rustc = Get-Command rustc -ErrorAction SilentlyContinue
if ($rustc) {
    try {
        $hostLine = (& rustc -vV) | Select-String '^host:'
        if ($hostLine) { $triple = ($hostLine.ToString() -split '\s+')[1] }
    } catch { }
}

$ffmpegExe = Join-Path $binDir "ffmpeg-$triple.exe"

if (-not $Force -and (Test-Path $ffmpegExe)) {
    Write-Host "ffmpeg sidecar already present (use -Force to re-download). Skipping."
    exit 0
}

$base = "https://github.com/BtbN/FFmpeg-Builds/releases/download/$Tag"
$tmp  = Join-Path ([System.IO.Path]::GetTempPath()) "kecilin-ffmpeg"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$zip = Join-Path $tmp $Asset

Write-Host "Downloading $base/$Asset ..."
Invoke-WebRequest -Uri "$base/$Asset" -OutFile $zip

# --- Integrity check ---
if (-not $ExpectedSha256) {
    try {
        $sums = (Invoke-WebRequest -Uri "$base/checksums.sha256" -UseBasicParsing).Content
        # PS 5.1 may hand back bytes for this content type.
        if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
        foreach ($line in ($sums -split "`n")) {
            if ($line -match "([0-9a-fA-F]{64})\s+\*?$([regex]::Escape($Asset))") {
                $ExpectedSha256 = $Matches[1]; break
            }
        }
    } catch {
        Write-Warning "Could not fetch checksums.sha256; skipping integrity check."
    }
}
# Compute SHA-256 via .NET (Get-FileHash is unavailable on some CI PowerShell hosts).
$sha256 = [System.Security.Cryptography.SHA256]::Create()
$stream = [System.IO.File]::OpenRead($zip)
try {
    $actual = [System.BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '')
} finally {
    $stream.Dispose()
    $sha256.Dispose()
}
if ($ExpectedSha256) {
    if ($actual -ne $ExpectedSha256.ToUpper()) {
        throw "SHA-256 mismatch for $Asset`n  expected $($ExpectedSha256.ToUpper())`n  actual   $actual"
    }
    Write-Host "SHA-256 OK: $actual"
} else {
    Write-Warning "No expected SHA-256 available; downloaded hash = $actual (NOT verified)."
}

# --- Extract ---
$ext = Join-Path $tmp "extracted"
if (Test-Path $ext) { Remove-Item -Recurse -Force $ext }
Expand-Archive -Path $zip -DestinationPath $ext -Force
# BtbN zips extract into a single top-level folder with bin/ffmpeg.exe inside.
$src = Get-ChildItem -Path $ext -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
if (-not $src) { throw "ffmpeg.exe not found inside $Asset" }

# --- Lay out ---
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
Copy-Item $src.FullName $ffmpegExe -Force

Write-Host ""
Write-Host "Done: $ffmpegExe"
