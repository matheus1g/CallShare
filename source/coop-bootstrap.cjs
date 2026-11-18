// API 5 adapter. It never installs a driver, changes routes or contacts arbitrary URLs.
const https=require('node:https');
const {RiseupBootstrap,PreparedRiseupSession,publicIPv4}=require('./riseup-bootstrap.cjs');
const ENDPOINTS=Object.freeze({provider:'https://beta.coopvpn.net/provider.json',service:'https://beta.coopvpn.net/api/5/service',
  gateways:'https://beta.coopvpn.net/api/5/gateways',identity:'https://beta.coopvpn.net/api/5/openvpn/cert'});
const failure=code=>Object.assign(new Error(code),{code});
function request(url,{signal,method='GET'}={}){
  if(!Object.values(ENDPOINTS).includes(url)||method!=='GET')return Promise.reject(failure('CS_PROVIDER_DESTINATION'));
  return new Promise((resolve,reject)=>{
    const req=https.get(url,{signal,rejectUnauthorized:true,minVersion:'TLSv1.2',timeout:15000,
      headers:{'User-Agent':'CallShare/0.13.7'}},res=>{
      let size=0;const chunks=[];
      res.on('data',b=>{size+=b.length;if(size>1048576)req.destroy(failure('CS_PROVIDER_SIZE'));else chunks.push(b);});
      res.on('error',()=>reject(failure('CS_PROVIDER_NETWORK')));
      res.on('end',()=>{const body=Buffer.concat(chunks);if(res.statusCode===200)resolve(body);else{body.fill(0);reject(failure('CS_PROVIDER_HTTP'));}});
    });
    const deadline=setTimeout(()=>req.destroy(failure('CS_PROVIDER_TIMEOUT')),20000);deadline.unref?.();
    req.once('close',()=>clearTimeout(deadline));req.on('timeout',()=>req.destroy(failure('CS_PROVIDER_TIMEOUT')));
    req.on('error',e=>reject(failure(signal?.aborted?'CS_CANCELLED':['CS_PROVIDER_SIZE','CS_PROVIDER_TIMEOUT'].includes(e.code)?e.code:'CS_PROVIDER_NETWORK')));
  });
}
class CoopBootstrap extends RiseupBootstrap {
  constructor({fetch=request,now=()=>Date.now()}={}){super({fetch,now});}
  validateProvider(p){
    if(p?.domain!=='beta.coopvpn.net'||p.api_version!=='5'||!['https://beta.coopvpn.net','https://beta.coopvpn.net/'].includes(p.api_uri)||
      p.service?.allow_anonymous!==true||p.service?.allow_registration!==false||!Array.isArray(p.services)||!p.services.includes('openvpn')||
      !/^[a-fA-F0-9]{64}$/.test(p.ca_cert_fingerprint||'')||p.ca_cert_uri!=='')throw failure('CS_PROVIDER_POLICY');
  }
  gateways(service,rows){
    const config=service?.openvpn_configuration;
    if(!service?.locations||!Array.isArray(rows)||rows.length>2000||config?.['data-ciphers']!=='AES-256-GCM'||config.auth!=='SHA512'||
      config['tls-version-min']!=='1.2'||config['tls-cipher']!=='TLS-ECDHE-ECDSA-WITH-AES-256-GCM-SHA384')throw failure('CS_PROVIDER_SERVICE');
    const usable=g=>g?.healthy===true&&g.overloaded===false&&g.type==='openvpn'&&publicIPv4(g.ip_addr)&&Number.isInteger(g.port)&&g.port>0&&g.port<=65535&&g.port!==53;
    const tcp=new Set(rows.filter(g=>usable(g)&&g.transport==='tcp').map(g=>g.ip_addr+':'+g.port)),seen=new Set(),out=[];
    for(const g of rows){
      const country=service.locations[g?.location]?.country_code,key=g?.ip_addr+':'+g?.port;
      if(!usable(g)||g.transport!=='udp'||!/^[A-Z]{2}$/.test(country)||country==='BR'||seen.has(key))continue;
      seen.add(key);out.push(Object.freeze({ip:g.ip_addr,port:g.port,country,tcp:tcp.has(key)}));
    }
    if(!out.length)throw failure('CS_PROVIDER_GATEWAY');return Object.freeze(out);
  }
  async discover({signal}={}){
    const provider=this.json(await this.fetch(ENDPOINTS.provider,{signal}));this.validateProvider(provider);
    const [service,rows]=await Promise.all([this.fetch(ENDPOINTS.service,{signal}),this.fetch(ENDPOINTS.gateways,{signal})]);
    return {provider:'coopvpn',fingerprint:'SHA256: '+provider.ca_cert_fingerprint.toLowerCase(),gateways:this.gateways(this.json(service),this.json(rows))};
  }
  async prepare({signal}={}){
    const discovery=await this.discover({signal});if(signal?.aborted)throw failure('CS_CANCELLED');
    const body=await this.fetch(ENDPOINTS.identity,{signal});let clientBody;
    try{
      let text=body.toString();if(text.trim().startsWith('"')){try{text=JSON.parse(text);}catch{throw failure('CS_PROVIDER_FORMAT');}}
      if(typeof text!=='string')throw failure('CS_PROVIDER_FORMAT');
      const certs=text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)||[];
      const keys=text.match(/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC )?PRIVATE KEY-----/g)||[];
      if(certs.length<2||certs.length>8||keys.length!==1)throw failure('CS_PROVIDER_IDENTITY');
      const ca=this.validateCA(certs.join('\n'),discovery.fingerprint);
      const crypto=require('node:crypto'),clients=certs.filter(pem=>!new crypto.X509Certificate(pem).ca);
      if(clients.length!==1)throw failure('CS_PROVIDER_IDENTITY');
      clientBody=Buffer.from(clients[0]+'\n'+keys[0]);const identity=this.validateIdentity(clientBody,ca.toString());
      if(signal?.aborted)throw failure('CS_CANCELLED');
      return new PreparedRiseupSession({...discovery,ca:Buffer.from(ca.toString())},identity);
    }catch(e){throw failure(/^CS_PROVIDER_[A-Z_]+$|^CS_CANCELLED$/.test(e.code||'')?e.code:'CS_PROVIDER_IDENTITY');}
    finally{body.fill(0);clientBody?.fill(0);}
  }
}
module.exports={CoopBootstrap,ENDPOINTS,requestCoopEndpoint:request};
