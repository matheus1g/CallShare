$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$cabRoot = Join-Path (Split-Path -Parent $PSScriptRoot) 'openvpn-build\cab'
$binaryRoot = Join-Path $PSScriptRoot 'build'
New-Item -ItemType Directory -Path $binaryRoot -Force | Out-Null
$normalizedRoot = Join-Path $binaryRoot 'runtime'
New-Item -ItemType Directory -Path $normalizedRoot -Force | Out-Null
$files = [ordered]@{
    'openvpn.exe'='bin.openvpn.exe'
    'tapctl.exe'='tapctl.exe'
    'libcrypto-3-x64.dll'='libcrypto_3_x64.dll'
    'libssl-3-x64.dll'='libssl_3_x64.dll'
    'libpkcs11-helper-1.dll'='libpkcs11_helper_1.dll'
    'vcruntime140.dll'='vcruntime140.dll'
    'ovpn-dco.inf'='ovpndco.inf.1057B5BE_89F7_469C_A3FD_D6662CD1D229'
    'ovpn-dco.sys'='ovpndco_nx20.sys.1057B5BE_89F7_469C_A3FD_D6662CD1D229'
    'ovpn-dco.cat'='ovpndco_nx20.cat.1057B5BE_89F7_469C_A3FD_D6662CD1D229'
}
$extraRoot = Join-Path $PSScriptRoot 'vendor\proxifyre'
if ((Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'vendor\ProxiFyre-v2.6.4-x64.zip') -Algorithm SHA256).Hash -ne 'c7da1dc5fdf9aaa7828fbf5c2076c4f612cba7889dcac2e3d06dc2e1dee4c3df') { throw 'ProxiFyre release hash mismatch' }
if ((Get-FileHash -LiteralPath (Join-Path $extraRoot 'socksify.dll') -Algorithm SHA256).Hash -ne '71478688111d0d976697db65bd37ed3c17504310562abefc4a1158a871bf4b8e') { throw 'ProxiFyre SDK hash mismatch' }
$files['socksify.dll']='@socksify.dll'
$hashRows = @()
$resourceArguments = @()
foreach ($file in $files.GetEnumerator()) {
    $path = Join-Path $normalizedRoot $file.Key
    if ($file.Value.StartsWith('@')) { $sourceFile=Join-Path $extraRoot $file.Value.Substring(1) } else { $sourceFile=Join-Path $cabRoot $file.Value }; Copy-Item -LiteralPath $sourceFile -Destination $path -Force
    $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    $hashRows += ('{"' + $file.Key + '","' + $hash + '"}')
    $resourceArguments += ('/resource:' + $path + ',runtime.' + $file.Key)
}
foreach ($name in @('bin.openvpn.exe','tapctl.exe')) {
    $signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $cabRoot $name)
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'OpenVPN') { throw 'Assinatura inválida de executável do OpenVPN.' }
}
foreach ($driverFile in @('ovpn-dco.cat','ovpn-dco.sys')) {
    $driverSignature = Get-AuthenticodeSignature -LiteralPath (Join-Path $normalizedRoot $driverFile)
    if ($driverSignature.Status -ne 'Valid' -or $driverSignature.SignerCertificate.Subject -notmatch 'Microsoft Windows Hardware Compatibility Publisher') { throw 'Assinatura inválida do driver.' }
}
$source = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'VpnWorker.cs'))
$source = $source.Replace('/*__RESOURCE_HASHES__*/', ($hashRows -join ",`n"))
$runtimeId = (Get-FileHash -LiteralPath (Join-Path $cabRoot 'bin.openvpn.exe') -Algorithm SHA256).Hash.Substring(0,16).ToLowerInvariant()
$source = $source.Replace('__RUNTIME_ID__', $runtimeId)
$builtSource = Join-Path $binaryRoot 'VpnWorker.generated.cs'
[System.IO.File]::WriteAllText($builtSource,$source,(New-Object System.Text.UTF8Encoding($false)))
$target = Join-Path $binaryRoot 'CallShare-vpn-worker.exe'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler '/nologo' '/target:winexe' '/platform:x64' '/optimize+' '/reference:System.Web.Extensions.dll' ('/out:' + $target) @resourceArguments $builtSource (Join-Path $PSScriptRoot 'SplitGuard.cs') (Join-Path $PSScriptRoot 'ScopedSocks.cs') (Join-Path $PSScriptRoot 'ProcessRouter.cs') (Join-Path $PSScriptRoot 'PacketModeGate.cs') (Join-Path $PSScriptRoot 'SocksNetworkSelfTest.cs') (Join-Path $PSScriptRoot 'DriverPreflight.cs') (Join-Path $PSScriptRoot 'VoicePass.cs') (Join-Path $PSScriptRoot 'NetworkDiagnostics.cs') (Join-Path $PSScriptRoot 'InterfaceDiagnostics.cs')
if ($LASTEXITCODE -ne 0) { throw 'Falha ao compilar controlador.' }
$test = Start-Process -FilePath $target -ArgumentList '--self-test' -WindowStyle Hidden -PassThru -Wait
if ($test.ExitCode -ne 0) { throw 'Autoteste do controlador falhou.' }
Write-Output 'Controlador compilado; autoteste passou sem ativar driver nem conexão.'
Get-FileHash -LiteralPath $target -Algorithm SHA256 | Format-List Algorithm, Hash
