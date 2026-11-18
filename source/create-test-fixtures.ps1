# Developer-only, unrelated to the VPN. Requires the OpenSSL command-line tool.
# Generates new local, self-signed test identities; no private key is distributed.
$ErrorActionPreference='Stop'
$fixtureRoot=Join-Path (Get-Location) 'work\provider-test-fixtures'
if (Test-Path -LiteralPath $fixtureRoot) { throw 'A pasta de testes já existe; não substituirei chaves.' }
$opensslExe=(Get-Command openssl.exe -ErrorAction Stop).Source
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
function InvokeTestOpenSSL([string[]]$Arguments) {
    & $opensslExe @Arguments *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Não foi possível criar a identidade de teste.' }
}
Push-Location -LiteralPath $fixtureRoot
try {
    foreach ($prefix in @('ca-test','client-ca-test')) {
        InvokeTestOpenSSL @('genpkey','-algorithm','RSA','-pkeyopt','rsa_keygen_bits:2048','-out',($prefix+'.key'))
        InvokeTestOpenSSL @('req','-new','-x509','-sha256','-key',($prefix+'.key'),'-out',($prefix+'.crt'),'-days','30','-subj',('/CN=CallShare Test '+$prefix),'-addext','basicConstraints=critical,CA:TRUE')
    }
    InvokeTestOpenSSL @('genpkey','-algorithm','RSA','-pkeyopt','rsa_keygen_bits:2048','-out','client-test.key')
    InvokeTestOpenSSL @('req','-new','-key','client-test.key','-out','client-test.csr','-subj','/CN=CallShare Test Client')
    InvokeTestOpenSSL @('x509','-req','-in','client-test.csr','-CA','ca-test.crt','-CAkey','ca-test.key','-set_serial','2','-days','30','-sha256','-out','client-test.crt')
    InvokeTestOpenSSL @('x509','-req','-in','client-test.csr','-CA','client-ca-test.crt','-CAkey','client-ca-test.key','-set_serial','3','-days','30','-sha256','-out','client-distinct-ca.crt')
} finally { Pop-Location }
Write-Host 'Identidades locais de teste geradas. Não use como credenciais reais nem distribua as chaves.'
