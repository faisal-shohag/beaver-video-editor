# Puts ffmpeg/ffprobe into src-tauri/binaries as Tauri sidecars.
#
#   pnpm ffmpeg:bundle              copy the FFmpeg found on PATH
#   pnpm ffmpeg:bundle -Download    download the pinned build (used by CI / releases)
param(
    [switch]$Download,
    [string]$Version = '8.1.1'
)
$ErrorActionPreference = 'Stop'
$triple = 'x86_64-pc-windows-msvc'
$dest = Join-Path $PSScriptRoot '..\src-tauri\binaries'
New-Item -ItemType Directory -Force $dest | Out-Null

if ($Download) {
    # Gyan.dev full build (GPL): includes libx264/x265, SVT-AV1, libvpx and AMF/NVENC/QSV encoders.
    $url = "https://github.com/GyanD/codexffmpeg/releases/download/$Version/ffmpeg-$Version-full_build.zip"
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) "ffmpeg-$Version"
    $zip = "$tmp.zip"
    if (-not (Test-Path $zip)) {
        Write-Host "Downloading $url"
        Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    }
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    Expand-Archive -Path $zip -DestinationPath $tmp
    $bin = Get-ChildItem -Path $tmp -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
    foreach ($name in 'ffmpeg', 'ffprobe') {
        Copy-Item (Join-Path $bin.DirectoryName "$name.exe") (Join-Path $dest "$name-$triple.exe") -Force
    }
    # Expose the bin dir so tests can call ffmpeg directly.
    if ($env:GITHUB_PATH) { Add-Content -Path $env:GITHUB_PATH -Value $bin.DirectoryName }
    Write-Host "Bundled FFmpeg $Version from $($bin.DirectoryName)"
    exit 0
}

foreach ($name in 'ffmpeg', 'ffprobe') {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $cmd) { throw "$name not found on PATH. Install with: winget install Gyan.FFmpeg (or run with -Download)" }
    $src = $cmd.Source
    $item = Get-Item $src
    if ($item.LinkTarget) { $src = $item.LinkTarget }
    $target = Join-Path $dest "$name-$triple.exe"
    if ((Test-Path $target) -and ((Get-Item $target).Length -eq (Get-Item $src).Length)) {
        Write-Host "$name already bundled"
        continue
    }
    Copy-Item $src $target -Force
    Write-Host "Bundled $src -> $target"
}
