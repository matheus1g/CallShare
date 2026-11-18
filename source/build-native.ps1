$ErrorActionPreference='Stop'
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$build=Join-Path $PSScriptRoot 'build'
New-Item -ItemType Directory -Path $build -Force | Out-Null
& (Join-Path $PSScriptRoot 'build-worker.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Worker build failed' }
$broker=Join-Path $build 'CallShareBroker.exe'
& $compiler /nologo /target:winexe /platform:x64 /reference:System.Web.Extensions.dll /reference:System.ServiceProcess.dll ('/out:'+$broker) (Join-Path $PSScriptRoot 'CallShareBroker.cs')
if ($LASTEXITCODE -ne 0) { throw 'Broker build failed' }
$test=Start-Process -FilePath $broker -ArgumentList '--self-test' -WindowStyle Hidden -PassThru -Wait
if ($test.ExitCode -ne 0) { throw 'Broker self-test failed' }
$driver=Join-Path $PSScriptRoot 'vendor\Windows.Packet.Filter.3.6.2.1.x64.msi'
if ((Get-FileHash -LiteralPath $driver -Algorithm SHA256).Hash -ne '9c388c0b7f189f7fa98720bae2caecf7d64f30910838b80b438ecf8956b8502c') { throw 'Driver package changed' }
if ((Get-AuthenticodeSignature -LiteralPath $driver).Status -ne 'Valid') { throw 'Driver package signature failed' }
$installer=Join-Path $build 'CallShare-install.exe'
$vc=Join-Path $PSScriptRoot 'vendor\VC_redist.x64.exe'
if ((Get-FileHash -LiteralPath $vc -Algorithm SHA256).Hash -ne 'cc0ff0eb1dc3f5188ae6300faef32bf5beeba4bdd6e8e445a9184072096b713b') { throw 'VC runtime package changed' }
$vcSignature=Get-AuthenticodeSignature -LiteralPath $vc
if ($vcSignature.Status -ne 'Valid' -or $vcSignature.SignerCertificate.Subject -notmatch 'Microsoft Corporation') { throw 'VC runtime signature failed' }
& $compiler /nologo /target:winexe /platform:x64 /reference:System.ServiceProcess.dll /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll ('/out:'+$installer) `
    ('/resource:'+$broker+',payload.CallShareBroker.exe') `
    ('/resource:'+(Join-Path $build 'CallShare-vpn-worker.exe')+',payload.CallShare-vpn-worker.exe') `
    ('/resource:'+$driver+',payload.Windows.Packet.Filter.3.6.2.1.x64.msi') `
    ('/resource:'+$vc+',payload.VC_redist.x64.exe') `
    (Join-Path $PSScriptRoot 'InstallBroker.cs') `
    (Join-Path $PSScriptRoot 'FirewallProfiles.cs')
if ($LASTEXITCODE -ne 0) { throw 'Installer build failed' }
$test=Start-Process -FilePath $installer -ArgumentList '--self-test' -WindowStyle Hidden -PassThru -Wait
if ($test.ExitCode -ne 0) { throw 'Installer self-test failed' }
Write-Output 'Native components built and self-tested. No service, driver or tunnel was installed or started.'
