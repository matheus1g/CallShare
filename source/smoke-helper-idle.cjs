// Exercises the actual SEA executable without /start, UAC, driver or network changes.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
(async()=>{
  const root=path.resolve('work/smoke-runtime-0.16.0');fs.mkdirSync(root,{recursive:true});
  const exe=path.join(root,'CallShare-helper.exe');fs.copyFileSync(require('./release-path.cjs').releasePath()+'/CallShare-runtime/CallShare-helper.exe',exe);
  const endpointFile=path.join(root,'control/endpoint.json');
  let previousInstance;try{previousInstance=JSON.parse(fs.readFileSync(endpointFile)).instance;}catch{}
  const child=cp.spawn(exe,[],{windowsHide:true,stdio:'ignore'});let exited=false;child.once('exit',()=>{exited=true;});
  try{
    const deadline=Date.now()+10000;let endpoint;
    while(Date.now()<deadline){try{const current=JSON.parse(fs.readFileSync(endpointFile));if(current.instance!==previousInstance){endpoint=current;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
    if(!endpoint||endpoint.version!=='0.16.0')throw Error('No current endpoint');
    const url='http://127.0.0.1:'+endpoint.controlPort;
    const refused=await fetch(url+'/status');if(refused.status!==403)throw Error('Unauthenticated request accepted');
    const headers={Authorization:'Bearer '+endpoint.token};
    const status=await (await fetch(url+'/status',{headers})).json();
    if(status.phase!=='idle'||status.routesVerified!==false||status.backend!=='leap-openvpn-process')throw Error('Unexpected idle state');
    const stopped=await fetch(url+'/stop',{method:'POST',headers});const value=await stopped.json();
    if(stopped.status!==200||value.cleanupConfirmed!==true||value.phase!=='stopped')throw Error('No stop confirmation');
    const finish=Date.now()+5000;while(!exited&&Date.now()<finish)await new Promise(r=>setTimeout(r,100));
    if(!exited||fs.existsSync(endpointFile))throw Error('Helper or endpoint remained');
    console.log('PASS: packaged GUI helper, authenticated loopback, idle stop, clean process exit. No VPN start/UAC requested.');
  }finally{if(!exited)child.kill();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
