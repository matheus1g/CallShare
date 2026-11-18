// Release notices are informational. A feed can supply only a version number.
const releaseNumber = value => typeof value === 'string' && /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(value);
function newerRelease(candidate, installed) {
    if (!releaseNumber(candidate) || !releaseNumber(installed)) return false;
    const next = candidate.split('.').map(Number), current = installed.split('.').map(Number);
    for (let i = 0; i < 3; i++) if (next[i] !== current[i]) return next[i] > current[i];
    return false;
}
function releaseFeedUrl(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 2048) return '';
    try {
        const url = new URL(value.trim());
        return url.protocol === 'https:' && !url.username && !url.password && !url.hash ? url.href : '';
    } catch { return ''; }
}
function smallReleaseFile(fs, file) {
    const size = fs.statSync(file).size;
    if (!Number.isInteger(size) || size < 1 || size > 4096) throw Error('metadata');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function inspectInstallation({fs, path, folder, programFiles, version, serviceVersion}) {
    const runtime = path.join(folder, 'CallShare-runtime');
    for (const name of ['CallShare-helper.exe','CallShare-install.exe']) {
        if (!fs.existsSync(path.join(runtime, name))) return 'package';
    }
    try {
        if (smallReleaseFile(fs, path.join(runtime,'release.json')).version !== version) return 'package';
    } catch { return 'package'; }
    // The renderer may hide the Windows environment. An absent file at the usual
    // location then warrants a first-use prompt, not a definitive missing-service claim.
    const service = path.join(programFiles || 'C:\\Program Files','CallShare');
    if (!['CallShareBroker.exe','CallShare-vpn-worker.exe'].every(n => fs.existsSync(path.join(service,n)))) {
        return programFiles ? 'install' : 'unconfirmed';
    }
    try {
        const actual = smallReleaseFile(fs,path.join(service,'CallShare-broker-status.json')).brokerVersion;
        if (releaseNumber(actual)) return actual === serviceVersion ? 'ready' : 'upgrade';
    } catch {}
    return 'unconfirmed';
}
const setupNotices = {
    package:'Copie o JS e a pasta CallShare-runtime do mesmo pacote para a pasta de plugins do BetterDiscord.',
    install:'Instale o auxiliar do Windows para preparar sua primeira transmissão.',
    upgrade:'Atualize o auxiliar do Windows para usar esta versão do CallShare.',
    unconfirmed:'A instalação do auxiliar ainda precisa de confirmação. No primeiro uso, instale-o antes de entrar na call.'
};
if(typeof module!=='undefined')module.exports={releaseNumber,newerRelease,releaseFeedUrl,inspectInstallation,setupNotices};
