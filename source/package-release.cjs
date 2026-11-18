// Release files only; never include control state, credentials or test keys.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const uiVersion=/const VERSION = "([^"]+)"/.exec(fs.readFileSync('work/next/CallShare-client.js','utf8'))[1];
const root=require('./release-path.cjs').mutableRelease(),runtime=path.join(root,'CallShare-runtime'),source=path.join(runtime,'source');
const copy=(from,to)=>{fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);};
for(const name of ['LEIA-ME.md','Instalar-CallShare.ps1'])copy(path.join('work/next',name),path.join(root,name));
copy('outputs/LICENSE-CallShare.txt',path.join(root,'LICENSE-CallShare.txt'));
copy('work/next/THIRD-PARTY.md',path.join(runtime,'docs/THIRD-PARTY.md'));
copy('work/next/VERIFICATION.md',path.join(runtime,'docs/VERIFICATION.md'));
copy('work/next/CHANGELOG.md',path.join(runtime,'docs/CHANGELOG.md'));
copy('work/next/BUILD.md',path.join(source,'BUILD.md'));
for(const name of ['session-contract.cjs','preparation-budget.cjs','panel-state.cjs','release-path.cjs','release.cjs','verify-ui.cjs','release-archive.py','package-release.cjs','smoke-helper-idle.cjs'])copy(path.join('work/next',name),path.join(source,name));
for(const name of ['auto-route.cjs','provider-monitor.cjs','provider-transport.cjs','coop-bootstrap.cjs','stream-bootstrap.cjs','route-diagnostics.cjs','CallShare-client.js','session-client.cjs','session-transport.cjs','riseup-bootstrap.cjs','vpn-broker.cjs','vpn-transport.cjs','service-client.cjs','helper-main.cjs','build-worker.ps1','build-native.ps1','build-helper.cjs','build-ui-patch.cjs','verify-native-patcher.cjs','verify-provider-fallback.cjs','smoke-provider-check.cjs','create-test-fixtures.ps1','create-coop-fixtures.ps1','broker-ipc-smoke.cjs'])copy(path.join('work/next',name),path.join(source,name));
copy('work/next/VpnWorker.cs',path.join(source,'VpnWorker.template.cs'));
for(const name of fs.readdirSync('work/next').filter(v=>v.endsWith('.test.cjs')))copy(path.join('work/next',name),path.join(source,'tests',name));
copy('outputs/CallShare-runtime/source/vendor/openvpn-2.7.8.tar.gz',path.join(source,'vendor/openvpn-2.7.8.tar.gz'));
copy('work/next/vendor/ProxiFyre-v2.6.4-x64.zip',path.join(source,'vendor/ProxiFyre-v2.6.4-x64.zip'));
const archive=path.join(source,'vendor/proxifyre-2.6.4-source.tar');
cp.execFileSync('git',['-C','work/proxifyre-reference','archive','--format=tar','--output='+archive,'5e3bc845d73a47a0931b1233c745580cb916f4ba']);
copy('work/helper-build/node_modules/postject/LICENSE',path.join(runtime,'docs/postject-LICENSE.txt'));
// Adjust the license notice to distinguish the linked AGPL worker from original MIT sources.
fs.appendFileSync(path.join(root,'LICENSE-CallShare.txt'),'\nThe worker linked with ProxiFyre is distributed as a combined work under AGPL-3.0.\nThe Windows Packet Filter kernel driver is closed source and has separate personal-use terms.\nSee CallShare-runtime/docs/THIRD-PARTY.md and proxifyre-AGPL-3.0.txt.\n');
const files={};
function visit(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
 const file=path.join(dir,entry.name),rel=path.relative(root,file).split(path.sep).join('/');
 if(entry.isSymbolicLink())throw Error('Unexpected link in release');
 if(/(?:^|\/)(?:control|state|data|sessions|private-probe|provider-test-fixtures|windivert|proxybridge)(?:\/|$)/i.test(rel)||/\.(?:key|pem|ovpn|log)$/i.test(rel))throw Error('Runtime/private state in release');
 if(entry.isDirectory())visit(file);else if(rel!=='SHA256.json')files[rel]=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}}
visit(root);fs.writeFileSync(path.join(root,'SHA256.json'),JSON.stringify({version:uiVersion,files},null,2)+'\n');
console.log(JSON.stringify({release:root,files:Object.keys(files).length,bytes:Object.keys(files).reduce((n,rel)=>n+fs.statSync(path.join(root,rel)).size,0)}));
