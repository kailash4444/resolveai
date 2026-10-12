param([switch]$Install, [string]$PythonPath = "$PSScriptRoot\.venv\Scripts\python.exe")

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

if ($Install -or -not (Test-Path $PythonPath)) {
  py -3.12 -m venv .venv
  $PythonPath = "$projectRoot\.venv\Scripts\python.exe"
  .\.venv\Scripts\python.exe -m pip install -r requirements-real.txt
}

$provider = & $PythonPath -c "from realapp.config import Settings; print(Settings().llm_provider)"
if ($provider -eq 'vertex') {
  Write-Host 'Using Google Vertex AI with Application Default Credentials (ADC).'
} elseif (-not $env:GEMINI_API_KEY) {
  Write-Host "ResolveAI will reuse the protected Gemini key from your Windows profile. If none is saved, use Configure key in the website." -ForegroundColor Yellow
}

& "$projectRoot\start-livekit-local.ps1" -PythonPath $PythonPath
& $PythonPath -m uvicorn realapp.main:app --host 127.0.0.1 --port 8080
