param([string]$PythonPath = "$PSScriptRoot\.venv\Scripts\python.exe")
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$prepared = & $PythonPath -m realapp.local_livekit | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the local LiveKit connection.' }
if ($prepared.mode -eq 'external') { Write-Host 'Using the configured LiveKit Cloud/external server.'; return }
$existing = Get-NetTCPConnection -LocalPort 7880 -State Listen -ErrorAction SilentlyContinue
if ($existing) { Write-Host 'A LiveKit server is already listening on port 7880.'; return }
$runtime = Join-Path $PSScriptRoot 'data\livekit-runtime'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$binary = Join-Path $runtime 'livekit-server.exe'
if (-not (Test-Path -LiteralPath $binary)) {
    $archive = Join-Path $runtime 'livekit.zip'
    Invoke-WebRequest 'https://github.com/livekit/livekit/releases/download/v1.13.9/livekit_1.13.9_windows_amd64.zip' -OutFile $archive
    $digest = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($digest -ne 'd5b5e44c197f613fdd6bdb2ae53e9d086d848156d43f614c688c6b595cd3f25e') { throw 'LiveKit download checksum did not match.' }
    Expand-Archive -LiteralPath $archive -DestinationPath $runtime -Force
}
$configArgument = '"' + $prepared.config_path + '"'
$process = Start-Process -FilePath $binary -ArgumentList @('--config', $configArgument) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'server.log') -RedirectStandardError (Join-Path $runtime 'server-error.log')
$process.Id | Set-Content -LiteralPath (Join-Path $runtime 'server.pid')
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if (Get-NetTCPConnection -LocalPort 7880 -State Listen -ErrorAction SilentlyContinue) { Write-Host 'LiveKit is running locally on port 7880.'; return }
    Start-Sleep -Milliseconds 500
    if ($process.HasExited) { throw 'LiveKit stopped during startup. See data/livekit-runtime/server-error.log.' }
}
throw 'LiveKit did not become ready. See data/livekit-runtime/server-error.log.'
