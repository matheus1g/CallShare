// Exercises the real C# pipe server as the current user. Status only; no service/worker/tunnel.
const net=require('node:net'),cp=require('node:child_process'),crypto=require('node:crypto'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const nonce=crypto.randomBytes(16).toString('hex'),pipe='\\\\.\\pipe\\CallShareBroker-test-'+nonce;
 const executable=path.resolve(process.argv[2]||'work/next/build/CallShareBroker.exe');
 const child=cp.spawn(executable,['--self-test-ipc',nonce],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 let diagnostics='',exited=false,exitCode;
 child.stderr.on('data',b=>{diagnostics+=b.toString();});
 child.once('exit',code=>{exited=true;exitCode=code;});
 try{
 const deadline=Date.now()+5000;let value,lastError;
  while(Date.now()<deadline&&!exited){
   try{value=await new Promise((resolve,reject)=>{
    const s=net.connect(pipe);let data='',done=false;
    const finish=(error,v)=>{if(done)return;done=true;s.destroy();error?reject(error):resolve(v);};
    s.setTimeout(1200,()=>finish(Error('pipe-timeout')));s.once('error',e=>finish(Error(e.code)));
    s.once('connect',()=>s.write(JSON.stringify({protocol:1,op:'status'})+'\n'));
    s.on('data',b=>{data+=b;if(data.length>4096)return finish(Error('pipe-size'));if(data.includes('\n')){try{finish(null,JSON.parse(data.split('\n')[0]));}catch{finish(Error('pipe-json'));}}});
    s.once('end',()=>{if(!done)finish(Error('pipe-closed'));});
   });break;}catch(e){lastError=e.message;await new Promise(r=>setTimeout(r,70));}
  }
  const until=Date.now()+1200;while(!exited&&Date.now()<until)await new Promise(r=>setTimeout(r,30));
  if(!value)throw Error('No authenticated status; '+lastError+'; '+diagnostics.trim());
  assert.equal(value.protocol,1);assert.equal(value.launched,false);assert.equal(value.failure,null);assert.equal(exitCode,0);
  console.log('PASS real C# broker authenticated Node status and exited. No service, worker or VPN started.');
 }finally{if(!exited)child.kill();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
