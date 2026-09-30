# Puts the sidecars into src-tauri/binaries: ffmpeg/ffprobe and deep-filter (DeepFilterNet3).
#
#   pnpm ffmpeg:bundle              copy the FFmpeg found on PATH
#   pnpm ffmpeg:bundle -Download    download the pinned FFmpeg build (used by CI / releases)
# deep-filter is always downloaded (pinned release, SHA-256 verified).
param(
    [switch]$Download,
    [string]$Version = '8.1.1'
)
$ErrorActionPreference = 'Stop'
$triple = 'x86_64-pc-windows-msvc'
$dest = Join-Path $PSScriptRoot '..\src-tauri\binaries'
New-Item -ItemType Directory -Force $dest | Out-Null

function Get-Sha256([string]$path) {
    # .NET directly: Get-FileHash is missing when Windows PowerShell is started from some shells.
    $stream = [System.IO.File]::OpenRead($path)
    try { ([System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash($stream)) -replace '-', '').ToLower() }
    finally { $stream.Dispose() }
}

# DeepFilterNet3 CLI (MIT/Apache-2.0), used by "Enhance voice".
$dfVersion = '0.5.6'
$dfSha = '75e11fa16445f560cb6b021521ddb89e89270d13b83089705d98776f58fd7915'
$dfTarget = Join-Path $dest "deep-filter-$triple.exe"
if (-not (Test-Path $dfTarget) -or (Get-Sha256 $dfTarget) -ne $dfSha) {
    $dfUrl = "https://github.com/Rikorose/DeepFilterNet/releases/download/v$dfVersion/deep-filter-$dfVersion-x86_64-pc-windows-msvc.exe"
    Write-Host "Downloading $dfUrl"
    Invoke-WebRequest -Uri $dfUrl -OutFile $dfTarget -UseBasicParsing
    if ((Get-Sha256 $dfTarget) -ne $dfSha) {
        Remove-Item $dfTarget
        throw "deep-filter checksum mismatch"
    }
}
Write-Host "Bundled deep-filter $dfVersion"

# ONNX Runtime (MIT) for DPDFNet / Sidon, loaded at runtime from the app's resource dir.
$ortVersion = '1.28.2'
$ortZipSha = 'c4eedd29489d5feca21866d054638416f3655bf6b18851b3b6b85c8313e95c35'
$ortTarget = Join-Path $dest 'onnxruntime.dll'
if (-not (Test-Path $ortTarget)) {
    $ortZip = Join-Path ([System.IO.Path]::GetTempPath()) "onnxruntime-win-x64-$ortVersion.zip"
    if (-not (Test-Path $ortZip) -or (Get-Sha256 $ortZip) -ne $ortZipSha) {
        $ortUrl = "https://github.com/microsoft/onnxruntime/releases/download/v$ortVersion/onnxruntime-win-x64-$ortVersion.zip"
        Write-Host "Downloading $ortUrl"
        Invoke-WebRequest -Uri $ortUrl -OutFile $ortZip -UseBasicParsing
        if ((Get-Sha256 $ortZip) -ne $ortZipSha) { throw "onnxruntime checksum mismatch" }
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($ortZip)
    try {
        $entry = $zip.Entries | Where-Object { $_.FullName -like '*/lib/onnxruntime.dll' } | Select-Object -First 1
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $ortTarget, $true)
    } finally { $zip.Dispose() }
}
Write-Host "Bundled onnxruntime $ortVersion"

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
