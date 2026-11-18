const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const {inject}=require('../helper-build/node_modules/postject');
const release=require('./release-path.cjs');
(async()=>{
  const uiVersion=/const VERSION = "([^"]+)"/.exec(fs.readFileSync('work/next/CallShare-client.js','utf8'))[1];
  const out=process.env.CALLSHARE_RELEASE_DIR?release.mutableRelease():release.newStage(),runtime=out+'/CallShare-runtime';
  fs.mkdirSync(runtime+'/source',{recursive:true});fs.mkdirSync(runtime+'/docs',{recursive:true});
  for(const name of ['CallShare-install.exe','CallShare-vpn-worker.exe','CallShareBroker.exe'])fs.copyFileSync('work/next/build/'+name,runtime+'/'+name);
  const modules=[['contract','session-contract.cjs'],['budget','preparation-budget.cjs'],['diagnostics','route-diagnostics.cjs'],['providerMonitor','provider-monitor.cjs'],['transport','session-transport.cjs'],['provider','riseup-bootstrap.cjs'],['coop','coop-bootstrap.cjs'],['service','service-client.cjs'],['broker','vpn-broker.cjs'],['vpn','vpn-transport.cjs'],['providers','provider-transport.cjs'],['helper','helper-main.cjs']];
  let entry='const __modules={};\n';
  const inputs={};
  for(const [name,file] of modules){let source=fs.readFileSync('work/next/'+file,'utf8');
    inputs[file]=crypto.createHash('sha256').update(source).digest('hex');
    for(const [key,other] of modules)source=source.replaceAll("require('./"+other+"')",'__modules.'+key);
    entry+='__modules.'+name+'=(()=>{const module={exports:{}};\n'+source+'\nreturn module.exports;})();\n';
  }
  entry+='__modules.helper.runCallShareHelper(require("node:path").dirname(process.execPath)).catch(()=>{process.exitCode=1;});\n';
  fs.writeFileSync(runtime+'/source/CallShare-helper.cjs',entry);
  const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const exe=runtime+'/CallShare-helper.exe',reuseHelper=process.argv.includes('--reuse-helper');
  if(reuseHelper){
    // UI-only patch: reuse an immutable, verified helper only when its exact source is unchanged.
    const base=path.join(release.workspace,'outputs/CallShare-0.14.0');
    const manifest=JSON.parse(fs.readFileSync(path.join(base,'SHA256.json')));
    if(manifest.version!=='0.14.0')throw Error('Wrong helper base');
    for(const [name,hash] of Object.entries(manifest.files))if(sha(path.join(base,name))!==hash)throw Error('Helper base changed: '+name);
    const previous=JSON.parse(fs.readFileSync(path.join(base,'CallShare-runtime/source/build-info.json')));
    if(JSON.stringify(inputs)!==JSON.stringify(previous.helperInputs)||entry!==fs.readFileSync(path.join(base,'CallShare-runtime/source/CallShare-helper.cjs'),'utf8'))throw Error('Helper sources changed; use a full build');
    const previousExe=path.join(base,'CallShare-runtime/CallShare-helper.exe');
    if(sha(previousExe)!==previous.helperSha256)throw Error('Helper hash mismatch');
    fs.copyFileSync(previousExe,exe);
  }else{
    const seaFile=path.join(path.dirname(out),'sea.json'),blobFile=path.join(path.dirname(out),'helper.blob');
    fs.writeFileSync(seaFile,JSON.stringify({main:path.resolve(runtime+'/source/CallShare-helper.cjs'),output:blobFile,disableExperimentalSEAWarning:true,useCodeCache:false,useSnapshot:false}));
    cp.execFileSync(process.execPath,['--experimental-sea-config',seaFile],{stdio:'inherit'});
    fs.copyFileSync(process.execPath,exe);
    await inject(exe,'NODE_SEA_BLOB',fs.readFileSync(blobFile),{sentinelFuse:'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'});
    const data=fs.readFileSync(exe),pe=data.readUInt32LE(0x3c);data.writeUInt16LE(2,pe+24+68);fs.writeFileSync(exe,data);
  }
  const rendererInputs={},readRenderer=file=>{const source=fs.readFileSync('work/next/'+file,'utf8');rendererInputs[file]=crypto.createHash('sha256').update(source).digest('hex');return source;};
  const client=readRenderer('CallShare-client.js').replace('__CALLSHARE_INSTALL_SHA256__',sha(runtime+'/CallShare-install.exe'));
  const transport=readRenderer('session-client.cjs').replace(/module\.exports=\{SessionClient\};\s*$/,'').replace('__CALLSHARE_HELPER_SHA256__',sha(exe));
  const inline=name=>readRenderer(name).replace(/if\(typeof module!==.*module\.exports=.*;\s*$/,'');
  const diagnostics=inline('route-diagnostics.cjs'),autoRoute=inline('auto-route.cjs'),providerMonitor=inline('provider-monitor.cjs'),bootstrap=inline('stream-bootstrap.cjs');
  fs.writeFileSync(out+'/CallShare.plugin.js',client+'\n\n'+inline('maintenance.cjs')+'\n\n'+inline('session-contract.cjs')+'\n\n'+inline('panel-state.cjs')+'\n\n'+autoRoute+'\n\n'+providerMonitor+'\n\n'+bootstrap+'\n\n'+diagnostics+'\n\n'+transport);
  cp.execFileSync(process.execPath,['--check',out+'/CallShare.plugin.js'],{stdio:'inherit'});
  fs.copyFileSync('work/node-LICENSE.txt',runtime+'/docs/node-LICENSE.txt');
  fs.copyFileSync('work/openvpn-build/cab/license.txt',runtime+'/docs/openvpn-LICENSE.txt');
  fs.copyFileSync('work/proxifyre-reference/LICENSE',runtime+'/docs/proxifyre-AGPL-3.0.txt');
  for(const file of ['InterfaceDiagnostics.cs','VoicePass.cs','NetworkDiagnostics.cs','CallShareBroker.cs','InstallBroker.cs','FirewallProfiles.cs','SplitGuard.cs','ScopedSocks.cs','ProcessRouter.cs','PacketModeGate.cs','DriverPreflight.cs','SocksNetworkSelfTest.cs'])fs.copyFileSync('work/next/'+file,runtime+'/source/'+file);
  fs.copyFileSync('work/next/build/VpnWorker.generated.cs',runtime+'/source/VpnWorker.cs');
  fs.writeFileSync(runtime+'/source/build-info.json',JSON.stringify({version:uiVersion,node:process.versions.node,helperInputs:inputs,rendererInputs,helperSha256:sha(exe),reusedHelperFrom:reuseHelper?'0.14.0':undefined},null,2));
  release.register(out);console.log(JSON.stringify({out,helper:sha(exe),installer:sha(runtime+'/CallShare-install.exe')}));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
