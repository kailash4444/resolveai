param([switch]$Install)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

if ($Install -or -not (Test-Path ".venv\Scripts\python.exe")) {
  py -3.12 -m venv .venv
  .\.venv\Scripts\python.exe -m pip install -r requirements-real.txt
}

if (-not $env:GEMINI_API_KEY) {
  Write-Host "ResolveAI will reuse the protected Gemini key from your Windows profile. If none is saved, use Configure key in the website." -ForegroundColor Yellow
}

& "$projectRoot\start-livekit-local.ps1" -PythonPath "$projectRoot\.venv\Scripts\python.exe"
.\.venv\Scripts\python.exe -m uvicorn realapp.main:app --host 127.0.0.1 --port 8080
