# Report the real on-screen rectangle of every Electron top-level window.
# ASCII only: Windows PowerShell 5.1 decodes BOM-less .ps1 as ANSI.

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
public class Win32Rect {
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
}
"@

Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {
    $r = New-Object RECT
    [void][Win32Rect]::GetWindowRect($_.MainWindowHandle, [ref]$r)
    $visible = [Win32Rect]::IsWindowVisible($_.MainWindowHandle)
    "pid={0} visible={1} rect={2},{3} size={4}x{5} title={6}" -f `
        $_.Id, $visible, $r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top), $_.MainWindowTitle
}