// One release entry point: staged build, checks, tests, UI, smoke, archive, promotion.
// Never installs a service/driver or invokes a VPN start operation.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const release=require('./release-path.cjs'),sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const final=path.join(release.workspace,'outputs/CallShare-'+release.version()),zip=final+'-completo.zip';
const ps=fs.existsSync('C:/Program Files/PowerShell/7/pwsh.exe')?'C:/Program Files/PowerShell/7/pwsh.exe':path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
const nativeUpdate=process.argv.includes('--native-update'),verifyStage=process.argv.includes('--verify-stage');
function run(file,args=[],env){cp.execFileSync(file,args,{cwd:release.workspace,env:env||process.env,stdio:'inherit',windowsHide:true});}
(async()=>{
  if(fs.existsSync(final)||fs.existsSync(zip))throw Error('This version is already published; choose a new version');
  const stage=verifyStage?release.mutableRelease():release.newStage();
  const env={...process.env,CALLSHARE_RELEASE_DIR:stage,CALLSHARE_NETWORK_TESTS:'1'};
  if(!verifyStage){
    if(nativeUpdate)run(ps,['-NoProfile','-File','work/next/build-native.ps1'],env);
    run(process.execPath,['work/next/build-helper.cjs',...(process.argv.includes('--reuse-helper')?['--reuse-helper']:[])],env);run(process.execPath,['work/next/package-release.cjs'],env);
  }
  const build=JSON.parse(fs.readFileSync(path.join(stage,'CallShare-runtime/source/build-info.json')));
  for(const [name,hash] of Object.entries(build.helperInputs))if(sha(path.join('work/next',name))!==hash)throw Error('Helper source changed; rebuild '+name);
  for(const [name,hash] of Object.entries(build.rendererInputs))if(sha(path.join('work/next',name))!==hash)throw Error('Renderer source changed; rebuild '+name);
  if(sha(path.join(stage,'CallShare-runtime/CallShare-helper.exe'))!==build.helperSha256)throw Error('Helper binary changed');
  const manifest=JSON.parse(fs.readFileSync(path.join(stage,'SHA256.json')));if(manifest.version!==release.version())throw Error('Wrong manifest version');
  for(const [name,hash] of Object.entries(manifest.files))if(sha(path.join(stage,name))!==hash)throw Error('Package file changed: '+name);
  const nativeBase=nativeUpdate?'work/next/build':'outputs/CallShare-0.15.2/CallShare-runtime';
  for(const name of ['CallShare-install.exe','CallShare-vpn-worker.exe','CallShareBroker.exe']){
    const file=path.join(stage,'CallShare-runtime',name);
    if(sha(file)!==sha(path.join(nativeBase,name)))throw Error('Protected binary differs from verified build: '+name);
    if(nativeUpdate&&verifyStage)run(file,['--self-test'],env);
  }
  if(build.reusedHelperFrom==='0.16.0'&&sha(path.join(stage,'CallShare-runtime/CallShare-helper.exe'))!==sha(path.join('outputs/CallShare-0.16.0/CallShare-runtime/CallShare-helper.exe')))throw Error('Reused helper changed');
  if(build.updaterSourceSha256!==sha('work/next/PackageUpdate.cs')||build.updaterSourceSha256!==sha(path.join(stage,'CallShare-runtime/source/PackageUpdate.cs')))throw Error('Updater source changed');
  run(process.execPath,['--check',path.join(stage,'CallShare.plugin.js')],env);
  const log=path.resolve('work/next/build/tests-'+release.version().replaceAll('.','')+'.log'),fd=fs.openSync(log,'w');
  try{cp.execFileSync(process.execPath,['--test','--test-timeout=20000',...fs.readdirSync('work/next').filter(n=>n.endsWith('.test.cjs')).map(n=>'work/next/'+n)],{env,windowsHide:true,stdio:['ignore',fd,fd]});}
  catch(error){process.stderr.write(fs.readFileSync(log,'utf8').slice(-3500));throw error;}finally{fs.closeSync(fd);}
  const results=fs.readFileSync(log,'utf8'),count=Number(/tests (\d+)/.exec(results)?.[1]);if(!count||!/fail 0/.test(results)||!/skipped 0/.test(results))throw Error('Incomplete tests');
  const visualPending=process.argv.includes('--allow-unverified-ui');
  if(!visualPending)run(process.execPath,['work/next/verify-ui.cjs'],env);
  run(process.execPath,['work/next/verify-native-patcher.cjs'],env);run(process.execPath,['work/next/smoke-helper-idle.cjs'],env);
  const installerPath=path.join(stage,'Instalar-CallShare.ps1');
  const staticInstaller=process.argv.includes('--static-installer-check');
  if(staticInstaller){
    // Parse only: respect Windows execution policy and never evaluate installer code.
    const parser="$tokens=$null; $parseErrors=$null; [System.Management.Automation.Language.Parser]::ParseFile($env:CALLSHARE_INSTALLER_CHECK,[ref]$tokens,[ref]$parseErrors) | Out-Null; if ($parseErrors.Count) { $parseErrors | ForEach-Object { Write-Error $_.Message }; exit 1 }; Write-Output 'PASS: installer syntax; script not executed.'";
    run(ps,['-NoProfile','-Command',parser],{...env,CALLSHARE_INSTALLER_CHECK:installerPath});
  }else run(ps,['-NoProfile','-File',installerPath,'-CheckOnly'],env);
  const tempZip=path.join(path.dirname(stage),'package.zip');
  const archive=JSON.parse(cp.execFileSync('python',['work/next/release-archive.py',stage,tempZip],{encoding:'utf8',windowsHide:true}));
  if(!release.inside(stage,release.workspace)||!release.inside(final,release.workspace)||!release.inside(tempZip,release.workspace))throw Error('Unsafe publication path');
  // All checks completed before either artifact becomes a published version.
  fs.renameSync(stage,final);
  try{fs.renameSync(tempZip,zip);}catch(error){fs.renameSync(final,stage);throw error;}
  release.register(final);
  const client=fs.readFileSync('work/next/CallShare-client.js','utf8');
  const helper=/const HELPER_VERSION = "([^"]+)"/.exec(client)[1],worker=/const BACKEND_VERSION = "([^"]+)"/.exec(client)[1];
  const info={version:release.version(),helper,worker,tests:count,skipped:0,protectedBinariesUnchanged:!nativeUpdate,archive,helperSha256:build.helperSha256,pluginSha256:sha(path.join(final,'CallShare.plugin.js')),visualVerification:visualPending?'pending: browser tools unavailable':'passed',installerVerification:staticInstaller?'syntax and package hashes passed; CheckOnly not executed (Windows policy)':'CheckOnly passed',actualVPNStarted:false};
  fs.writeFileSync(final+'-release.json',JSON.stringify(info,null,2)+'\n');console.log(JSON.stringify(info));
})().catch(error=>{console.error('Release not published: '+error.message);process.exitCode=1;});
