# Launch the Claude-chan desktop pet with an Electron runtime already on this machine.
# ASCII only: Windows PowerShell 5.1 decodes BOM-less .ps1 as ANSI and non-ASCII breaks parsing.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

function Find-Electron {
    $candidates = @()
    if ($env:CLAUDE_CHAN_PET_ELECTRON) { $candidates += $env:CLAUDE_CHAN_PET_ELECTRON }
    $candidates += (Join-Path $HOME '.dsh\electron\electron.exe')
    $candidates += (Join-Path $root 'node_modules\electron\dist\electron.exe')
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c)) { return $c }
    }
    if (Get-Command npx -ErrorAction SilentlyContinue) { return 'npx electron' }
    throw 'Electron not found. Install it or set CLAUDE_CHAN_PET_ELECTRON to electron(.exe).'
}

$electron = Find-Electron
Write-Host "electron : $electron"
Write-Host "app      : $root"
Write-Host "events   : $HOME\.claude-chan-pet\events.jsonl"

if ($electron -eq 'npx electron') {
    & npx electron $root @args
} else {
    & $electron $root @args
}