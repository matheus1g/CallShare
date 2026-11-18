# Development only. Generate a local Ed25519 leaf, never distribute its key.
$ErrorActionPreference='Stop'
$fixtureRoot=Join-Path (Get-Location) 'work\provider-test-fixtures'
$opensslExe='C:\Program Files\Git\mingw64\bin\openssl.exe'
if (Test-Path -LiteralPath (Join-Path $fixtureRoot 'client-ed25519.key')) { throw 'A identidade de teste já existe.' }
function InvokeFixtureOpenSSL([string[]]$Arguments) { & $opensslExe @Arguments *> $null; if($LASTEXITCODE -ne 0){throw 'Falha ao gerar identidade de teste.'} }
Push-Location -LiteralPath $fixtureRoot
try {
    InvokeFixtureOpenSSL @('genpkey','-algorithm','ED25519','-out','client-ed25519.key')
    InvokeFixtureOpenSSL @('req','-new','-key','client-ed25519.key','-out','client-ed25519.csr','-subj','/CN=CallShare Test Ed25519')
    InvokeFixtureOpenSSL @('x509','-req','-in','client-ed25519.csr','-CA','client-ca-test.crt','-CAkey','client-ca-test.key','-set_serial','7','-days','30','-sha256','-out','client-ed25519.crt')
} finally { Pop-Location }
Write-Host 'Identidade Ed25519 de teste gerada localmente.'
