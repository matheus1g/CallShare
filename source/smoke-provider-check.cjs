// Exercises the packaged public-certificate endpoint in an isolated work folder.
// Never requests /start, an identity, the service or a VPN/driver operation.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
(async()=>{
    const root=fs.mkdtempSync(path.resolve('work/provider-probe-0140-')),exe=path.join(root,'CallShare-helper.exe');
    fs.copyFileSync(require('./release-path.cjs').releasePath()+'/CallShare-runtime/CallShare-helper.exe',exe);
    const endpointFile=path.join(root,'control/endpoint.json');
    const child=cp.spawn(exe,[],{windowsHide:true,stdio:'ignore'});let exited=false;child.once('exit',()=>exited=true);
    let endpoint;
    try{
        const deadline=Date.now()+10000;
        while(Date.now()<deadline&&!exited){try{endpoint=JSON.parse(fs.readFileSync(endpointFile));break;}catch{await new Promise(r=>setTimeout(r,100));}}
        assert.equal(endpoint?.version,'0.15.2');const base='http://127.0.0.1:'+endpoint.controlPort,headers={Authorization:'Bearer '+endpoint.token};
        assert.equal((await fetch(base+'/provider-check',{method:'POST'})).status,403);
        const result=await (await fetch(base+'/provider-check',{method:'POST',headers})).json();
        assert.equal(result.version,'0.15.2');assert.equal(result.providerCertificate.provider,'riseup');
        const status=await (await fetch(base+'/status',{headers})).json();assert.equal(status.phase,'idle');assert.equal(status.routesVerified,false);
        const stopped=await (await fetch(base+'/stop',{method:'POST',headers})).json();assert.equal(stopped.cleanupConfirmed,true);
        const until=Date.now()+5000;while(!exited&&Date.now()<until)await new Promise(r=>setTimeout(r,100));assert.equal(exited,true);assert.equal(fs.existsSync(endpointFile),false);
        const info={...result.providerCertificate,helperVersion:result.version,phaseAfterProbe:status.phase,noVPNStartRequested:true};
        fs.writeFileSync('work/next/build/live-provider-probe-0140.json',JSON.stringify(info,null,2));console.log(JSON.stringify(info));
    }finally{if(!exited)child.kill();}
})().catch(error=>{console.error(error.name+': '+error.message);process.exitCode=1;});
