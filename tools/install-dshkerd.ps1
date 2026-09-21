[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+$')]
  [string]$Version,
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'DSHKer\bin')
)

$ErrorActionPreference = 'Stop'
$StrictModeVersion = 'Latest'
Set-StrictMode -Version $StrictModeVersion
$ProgressPreference = 'SilentlyContinue'
$repository = 'ankye/dshker'
$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
switch ($architecture) {
  'X64' { $target = 'windows-x64' }
  'Arm64' { $target = 'windows-arm64' }
  default { throw "install-dshkerd: unsupported Windows architecture $architecture" }
}
if ([string]::IsNullOrWhiteSpace($InstallDir) -or -not [System.IO.Path]::IsPathRooted($InstallDir)) {
  throw 'install-dshkerd: -InstallDir must be an absolute path'
}

$archive = "dshkerd-$Version-$target.zip"
$checksums = "dshkerd-$Version-checksums.txt"
$baseUrl = "https://github.com/$repository/releases/download/v$Version"
$temporaryDir = Join-Path ([System.IO.Path]::GetTempPath()) "dshkerd-install-$([guid]::NewGuid().ToString('N'))"
$staged = $null
New-Item -ItemType Directory -Force -Path $temporaryDir | Out-Null
try {
  $archivePath = Join-Path $temporaryDir $archive
  $checksumsPath = Join-Path $temporaryDir $checksums
  Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$archive" -OutFile $archivePath
  Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$checksums" -OutFile $checksumsPath

  $checksumLine = Get-Content -LiteralPath $checksumsPath |
    Where-Object { $_ -match ("\s" + [regex]::Escape($archive) + '$') } |
    Select-Object -First 1
  if (-not $checksumLine) { throw "install-dshkerd: release checksum does not list $archive" }
  $expectedArchiveSha256 = ($checksumLine -split '\s+')[0].ToLowerInvariant()
  $actualArchiveSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
  if ($actualArchiveSha256 -ne $expectedArchiveSha256) {
    throw "install-dshkerd: checksum mismatch for $archive; existing installation was not changed"
  }

  $extractDir = Join-Path $temporaryDir 'extracted'
  Expand-Archive -LiteralPath $archivePath -DestinationPath $extractDir
  $packageDir = Join-Path $extractDir "dshkerd-$Version-$target"
  $binary = Join-Path $packageDir 'dshkerd.exe'
  $manifestPath = Join-Path $packageDir 'dshkerd-manifest.json'
  $versionPath = Join-Path $packageDir 'VERSION'
  foreach ($required in @($binary, $manifestPath, $versionPath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "install-dshkerd: archive is missing $required" }
  }
  $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  if ($manifest.version -ne $Version -or $manifest.target -ne $target -or $manifest.executable -ne 'dshkerd.exe') {
    throw 'install-dshkerd: manifest identity mismatch'
  }
  $actualBinarySha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $binary).Hash.ToLowerInvariant()
  if ($actualBinarySha256 -ne $manifest.sha256.ToLowerInvariant()) {
    throw 'install-dshkerd: binary does not match its embedded manifest'
  }

  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $staged = Join-Path $InstallDir ".dshkerd.$Version.$target.$PID.tmp"
  Copy-Item -LiteralPath $binary -Destination $staged -Force
  Move-Item -LiteralPath $staged -Destination (Join-Path $InstallDir 'dshkerd.exe') -Force
  Write-Output "Installed dshkerd $Version ($target) to $(Join-Path $InstallDir 'dshkerd.exe')"
  Write-Output 'Next: add that directory to PATH if needed, then run dshkerd.exe help.'
}
finally {
  if ($staged -and (Test-Path -LiteralPath $staged)) { Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $temporaryDir) { Remove-Item -LiteralPath $temporaryDir -Recurse -Force -ErrorAction SilentlyContinue }
}
