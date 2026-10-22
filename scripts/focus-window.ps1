# Focus a window by process id and print its real on-screen rectangle.
# Usage: pwsh -NoProfile -File focus-window.ps1 -ProcessId 27840
# ASCII only: Windows PowerShell 5.1 decodes BOM-less .ps1 as ANSI.

param([Parameter(Mandatory = $true)][int]$ProcessId)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
public class Win32Focus {
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@

$proc = Get-Process -Id $ProcessId -ErrorAction Stop
$handle = $proc.MainWindowHandle
if ($handle -eq [IntPtr]::Zero) { throw "Process $ProcessId has no main window." }

[void][Win32Focus]::SetForegroundWindow($handle)
Start-Sleep -Milliseconds 900

$r = New-Object RECT
[void][Win32Focus]::GetWindowRect($handle, [ref]$r)
"pid={0} title={1}" -f $ProcessId, $proc.MainWindowTitle
"rect={0},{1} size={2}x{3}" -f $r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top)