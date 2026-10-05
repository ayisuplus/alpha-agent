param([Parameter(Mandatory=$true)][string]$Archive, [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskDestination = [System.IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
$taskZip = [System.IO.Compression.ZipFile]::OpenRead([System.IO.Path]::GetFullPath($Archive))
try {
  $taskNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  [long]$taskTotal = 0
  foreach ($taskEntry in $taskZip.Entries) {
    $taskName = $taskEntry.FullName.Replace('\', '/').TrimEnd('/')
    if (!$taskName -or $taskName -match '(^/|^[A-Za-z]:|(^|/)\.\.(/|$)|[\x00-\x1f:<>"|?*])' -or !$taskNames.Add($taskName)) { throw 'Invalid or duplicate archive path' }
    if ((($taskEntry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'Archive links are unsupported' }
    $taskPath = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($taskDestination, $taskName))
    if (!$taskPath.StartsWith($taskDestination, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path leaves staging directory' }
    $taskTotal += $taskEntry.Length
    if ($taskTotal -gt 8589934592 -or $taskZip.Entries.Count -gt 200000) { throw 'Archive exceeds update limits' }
  }
} finally { $taskZip.Dispose() }
[System.IO.Compression.ZipFile]::ExtractToDirectory([System.IO.Path]::GetFullPath($Archive), $taskDestination)
