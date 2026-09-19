param(
  [string]$InstallerPath = "",
  [int]$MaxSizeMB = 200
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$package = Get-Content -Path (Join-Path $projectRoot "package.json") -Raw | ConvertFrom-Json
$productName = [string]$package.build.productName
$version = [string]$package.version

if ([string]::IsNullOrWhiteSpace($InstallerPath)) {
  $InstallerPath = Join-Path $projectRoot ("release\\{0} Setup {1}.exe" -f $productName, $version)
}

if (!(Test-Path $InstallerPath)) {
  throw "Installer not found: $InstallerPath"
}

$installerItem = Get-Item -LiteralPath $InstallerPath
$sizeMB = [math]::Round(($installerItem.Length / 1MB), 2)
if ($sizeMB -gt $MaxSizeMB) {
  throw "Installer is too large: $sizeMB MB (limit: $MaxSizeMB MB)"
}
Write-Output ("installer_size_mb={0}" -f $sizeMB)

$installDir = Join-Path $env:LOCALAPPDATA ("Programs\\{0}" -f $productName)
$desktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) ("{0}.lnk" -f $productName)
$startMenuShortcut = Join-Path $env:APPDATA ("Microsoft\\Windows\\Start Menu\\Programs\\{0}.lnk" -f $productName)

if (Test-Path $installDir) {
  Remove-Item -LiteralPath $installDir -Recurse -Force
}

$installProcess = Start-Process -FilePath $InstallerPath -ArgumentList "/S" -PassThru -Wait -WindowStyle Hidden
if ($installProcess.ExitCode -ne 0) {
  throw "Installer returned exit code $($installProcess.ExitCode)"
}
Write-Output "install_exit_code=0"

$appExePath = Join-Path $installDir ("{0}.exe" -f $productName)
if (!(Test-Path $appExePath)) {
  throw "Installed app exe not found: $appExePath"
}
Write-Output "installed_exe_found=1"

$desktopFound = Test-Path $desktopShortcut
$startMenuFound = Test-Path $startMenuShortcut
Write-Output ("desktop_shortcut_found={0}" -f ([int]$desktopFound))
Write-Output ("start_menu_shortcut_found={0}" -f ([int]$startMenuFound))

$appProcess = Start-Process -FilePath $appExePath -PassThru
Start-Sleep -Seconds 6
if ($appProcess.HasExited) {
  Write-Output ("app_exit_code={0}" -f $appProcess.ExitCode)
} else {
  Write-Output "app_started=1"
  Stop-Process -Id $appProcess.Id -Force
  Write-Output "app_stopped=1"
}

$uninstallerPath = Join-Path $installDir ("Uninstall {0}.exe" -f $productName)
if (!(Test-Path $uninstallerPath)) {
  throw "Uninstaller not found: $uninstallerPath"
}

$uninstallProcess = Start-Process -FilePath $uninstallerPath -ArgumentList "/S" -PassThru -Wait -WindowStyle Hidden
if ($uninstallProcess.ExitCode -ne 0) {
  throw "Uninstaller returned exit code $($uninstallProcess.ExitCode)"
}
Write-Output "uninstall_exit_code=0"

if (Test-Path $installDir) {
  Remove-Item -LiteralPath $installDir -Recurse -Force
}
if (Test-Path $desktopShortcut) {
  Remove-Item -LiteralPath $desktopShortcut -Force
}
if (Test-Path $startMenuShortcut) {
  Remove-Item -LiteralPath $startMenuShortcut -Force
}

Write-Output "verify_installer_done=1"
