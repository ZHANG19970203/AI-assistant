param([switch]$ImportCandidates)
$ErrorActionPreference = 'Stop'
$taskProjectRoot = Split-Path -Parent $PSScriptRoot
$taskBundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$taskNodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $taskBundledNode) {
    $taskNodeExecutable = $taskBundledNode
} elseif ($taskNodeCommand) {
    $taskNodeExecutable = $taskNodeCommand.Source
} else {
    throw 'Node.js 24 or later is required. Run npm install after installing Node. The SiliconFlow API key is optional for offline use.'
}
$taskNodeMajor = [int]((& $taskNodeExecutable --version).TrimStart('v').Split('.')[0])
if ($taskNodeMajor -lt 24) { throw 'Please use Node.js 24 or later.' }
Set-Location -LiteralPath $taskProjectRoot
if ($ImportCandidates) {
    & $taskNodeExecutable (Join-Path $taskProjectRoot 'scripts\import-candidates.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Candidate import failed; nothing was approved.' }
    Write-Host 'Candidates remain pending. Open the teacher document page to review.'
    exit
}
if (-not (Test-Path -LiteralPath (Join-Path $taskProjectRoot 'node_modules\exceljs'))) { throw 'Dependencies missing. Run npm install in this project directory, then start again.' }
Write-Host 'Local preview: http://127.0.0.1:4317 . Press Ctrl+C to stop. Optional DeepSeek config is read from .env.local.'
& $taskNodeExecutable (Join-Path $taskProjectRoot 'server.mjs')
