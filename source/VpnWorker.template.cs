// Original CallShare controller. Embedded third-party binaries retain their own licenses.
using System;
using System.IO;
using System.IO.Pipes;
using System.Net;
using System.Net.NetworkInformation;
using System.Diagnostics;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Collections;
using System.Collections.Generic;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using Microsoft.Win32;

internal class VpnWorker {
    static readonly object Gate = new object();
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 131072, RecursionLimit = 12 };
    static string Token, PipeName, UserSid, Stage="idle", ErrorCode=null, Country=null, FailureStage=null;
    static string RuntimeDir, SessionDir, AdapterId=null, AdapterSelector=null;
    static Process Child;
    static EventWaitHandle ExitEvent;
    static Thread Work;
    static volatile bool Cancelled=false, Done=false, ExitRequested=false, RoutesVerified=false, Cleaned=false;
    static DateTime CompletedAt=DateTime.MaxValue;
    static IntPtr Job=IntPtr.Zero;
    static DateTime Lease=DateTime.UtcNow;
    static bool ChildStarted=false;
    static int? NativeExitCode=null;
    static string NativeReason=null;
    static readonly HashSet<string> NativeMarkers=new HashSet<string>();
    static SplitGuard Isolation;
    static ScopedSocks Proxy;
    static ProcessRouter Router;
    static volatile bool RequestedRouting=true;
    static bool Isolated=false;
    static string AddressState="not-checked";
    static int OwnedIndex=0;
    // Replaced at build time, covering the exact bytes embedded in this executable.
    static readonly Dictionary<string,string> Hashes = new Dictionary<string,string> {
        /*__RESOURCE_HASHES__*/
    };
    class Candidate { public string Ip; public int Port; public string Country; public bool Tcp; }
    class Settings { public string Ca,Cert,Key,VoiceIp; public int VoicePort; public bool Standby; public List<Candidate> Servers; }
    static NetworkDiagnostics.Snapshot NetworkSnapshot;
    static NetworkDiagnostics.Snapshot NetworkBefore;
    static List<string> TargetPaths;
    static DateTime LastNetworkSnapshot=DateTime.MinValue;
    static void Main(string[] args) {
        try {
            if(args.Length==1 && args[0]=="--self-test") { SelfTest(); return; }
            if(args.Length==1 && args[0]=="--self-test-diagnostics") {InterfaceDiagnostics.ReadOnlyCheck();return;}
            if(args.Length==1 && args[0]=="--self-test-network") {SocksNetworkSelfTest.Run();return;}
            if(args.Length==1 && args[0]=="--self-test-output") {Console.Error.WriteLine("Options error: synthetic-private-token");Environment.ExitCode=23;return;}
            if(args.Length!=6 || args[0]!="--pipe" || args[2]!="--token" || args[4]!="--user-sid") throw new Exception("CS_WORKER_ARGUMENTS");
            PipeName=args[1];Token=args[3];UserSid=new SecurityIdentifier(args[5]).Value;
            if(!new SecurityIdentifier(UserSid).IsAccountSid())throw new Exception("CS_WORKER_ARGUMENTS");
            if(!Regex.IsMatch(Token,"\\A[a-f0-9]{64}\\z") || PipeName!="callshare-vpn-"+Token.Substring(0,24))throw new Exception("CS_WORKER_ARGUMENTS");
            if(!new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator))throw new Exception("CS_WORKER_ADMIN");
            using(var watchdog=new Timer(delegate(object unused) {
                if((DateTime.UtcNow-Lease).TotalSeconds>35) RequestStop();
                if(Done&&(DateTime.UtcNow-CompletedAt).TotalSeconds>10)ExitRequested=true;
            },null,1000,1000)) Serve();
        } catch(Exception error) {if(args.Length==1&&args[0].StartsWith("--self-test",StringComparison.Ordinal))Console.Error.WriteLine(error.GetType().Name+": "+error.Message);Environment.ExitCode=1; }
        finally { RequestStop(); if(Work!=null)Work.Join(15000); }
    }
    static object Status() {
        lock(Gate) {var routeProof=Isolation==null?null:Isolation.LastRouteProof;return new {stage=Stage,failure=ErrorCode,failureStage=FailureStage,country=Country,routesVerified=RoutesVerified,
            nativeExitCode=NativeExitCode,nativeReason=NativeReason,nativeMarkers=new List<string>(NativeMarkers),
            isolationVerified=Isolated,normalRoutePreserved=routeProof!=null&&routeProof.normalPreserved,
            routeProof=routeProof,network=NetworkSnapshot,networkBefore=NetworkBefore,voiceFilter=VoicePass.LastProof,
            addressState=AddressState,proxyDiagnostic=Proxy==null?ScopedSocks.StartupDiagnostic:Proxy.GatewayDiagnostic,
            isolationError=SplitGuard.LastError,isolationStage=SplitGuard.LastStage,processRuleCount=Router==null?0:Router.RuleCount,proxyPort=Proxy==null?0:Proxy.Port,
            tcpRelays=Proxy==null?0:Interlocked.Read(ref Proxy.TcpConnections),udpRelays=Proxy==null?0:Proxy.UdpPackets,
            routingActive=Router!=null&&Router.Active,standbyVerified=Router!=null&&Router.StandbyVerified,
            routerLifecycle=Router==null?null:Router.Lifecycle,
            cleanupConfirmed=Cleaned,scope="discord-process-ipv4",workerVersion="0.13.4"};}
    }
    static void State(string value) { lock(Gate)Stage=value; }
    static void CheckCancel() { lock(Gate)if(Cancelled)throw new Exception("CS_CANCELLED"); }
    static void RequestStop() { lock(Gate) { Cancelled=true; if(!Done)Stage="stopping"; } }
    static void Serve() {
        var security=new PipeSecurity();security.SetAccessRuleProtection(true,false);
        foreach(var sid in new [] {UserSid,"S-1-5-18","S-1-5-32-544"})
            security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(sid),PipeAccessRights.FullControl,AccessControlType.Allow));
        while(!ExitRequested) {
            using(var pipe=new NamedPipeServerStream(PipeName,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,65536,65536,security)) {
                var pending=pipe.BeginWaitForConnection(null,null);
                while(!pending.AsyncWaitHandle.WaitOne(250)) {
                    if(ExitRequested)return;
                    if(Cancelled && Work==null&&!Done){Done=true;Cleaned=true;CompletedAt=DateTime.UtcNow;Stage="stopped";}
                }
                pipe.EndWaitForConnection(pending);
                using(var deadline=new Timer(delegate(object unused){try{pipe.Dispose();}catch{}},null,4000,Timeout.Infinite)) {
                    try {
                        var bytes=new MemoryStream();int next;
                        while((next=pipe.ReadByte())!=-1 && next!=10){if(bytes.Length>=131072)throw new Exception();bytes.WriteByte((byte)next);}
                        var request=Json.Deserialize<Dictionary<string,object>>(Encoding.UTF8.GetString(bytes.ToArray()));
                        string token=Text(request,"token",64),op=Text(request,"op",16);
                        if(!FixedEquals(token,Token))throw new Exception();
                        lock(Gate)Lease=DateTime.UtcNow;
                        if(op=="start") {
                            lock(Gate) {
                                if(Work==null && !Cancelled) {
                                    var settings=Parse((Dictionary<string,object>)request["payload"]);
                                    RequestedRouting=!settings.Standby;
                                    Work=new Thread(delegate(){Run(settings);});Work.IsBackground=false;Work.Start();
                                }
                            }
                        } else if(op=="stop")RequestStop();
                        else if(op=="resume"||op=="pause"){lock(Gate){if(Stage!="connected"||Cancelled)throw new Exception();RequestedRouting=op=="resume";}}
                        else if(op!="status")throw new Exception();
                        var response=Encoding.UTF8.GetBytes(Json.Serialize(Status())+"\n");pipe.Write(response,0,response.Length);pipe.Flush();
                        if(Done)ExitRequested=true;
                    }catch {
                        try { var refused=Encoding.UTF8.GetBytes("{\"refused\":true}\n");pipe.Write(refused,0,refused.Length); }catch{}
                    }
                }
            }
        }
    }
    static bool FixedEquals(string a,string b){if(a.Length!=b.Length)return false;int n=0;for(int i=0;i<a.Length;i++)n|=a[i]^b[i];return n==0;}
    static string Text(Dictionary<string,object> value,string key,int max){object item;if(!value.TryGetValue(key,out item)||!(item is string)||((string)item).Length>max)throw new Exception("CS_WORKER_INPUT");return (string)item;}
    static bool PublicIp(string text) {
        IPAddress address;if(!IPAddress.TryParse(text,out address)||address.AddressFamily!=System.Net.Sockets.AddressFamily.InterNetwork||address.ToString()!=text)return false;
        byte[] p=address.GetAddressBytes();int a=p[0],b=p[1],c=p[2];
        return a>0&&a<224&&a!=10&&a!=127&&!(a==100&&b>=64&&b<=127)&&!(a==169&&b==254)&&
            !(a==172&&b>=16&&b<=31)&&!(a==192&&b==168)&&!(a==192&&b==0&&(c==0||c==2))&&
            !(a==198&&(b==18||b==19||b==51&&c==100))&&!(a==203&&b==0&&c==113);
    }
    static string Pem(string text,string label) {
        var match=Regex.Match(text,"\\A\\s*-----BEGIN "+label+"-----([A-Za-z0-9+/=\\r\\n]+)-----END "+label+"-----\\s*\\z");
        if(!match.Success)throw new Exception("CS_WORKER_PEM");
        byte[] der=Convert.FromBase64String(match.Groups[1].Value);
        if(der.Length<32||der.Length>16384||der[0]!=0x30)throw new Exception("CS_WORKER_PEM");
        return "-----BEGIN "+label+"-----\n"+Convert.ToBase64String(der,Base64FormattingOptions.InsertLineBreaks)+"\n-----END "+label+"-----\n";
    }
    static string Cert(string pem,bool ca) {
        string normalized=Pem(pem,"CERTIFICATE");
        using(var cert=new X509Certificate2(Convert.FromBase64String(Regex.Match(normalized,"-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\\r\\n]+)-----END").Groups[1].Value))) {
            if(DateTime.UtcNow<cert.NotBefore.ToUniversalTime()||DateTime.UtcNow>=cert.NotAfter.ToUniversalTime())throw new Exception("CS_WORKER_CERT");
            bool authority=false;
            foreach(var ext in cert.Extensions)if(ext.Oid.Value=="2.5.29.19")authority=new X509BasicConstraintsExtension(ext,ext.Critical).CertificateAuthority;
            if(authority!=ca)throw new Exception("CS_WORKER_CERT");
        }
        return normalized;
    }
    static Settings Parse(Dictionary<string,object> input) {
        // Only credential blocks are accepted. Raw OpenVPN options/paths never cross this boundary.
        foreach(var key in input.Keys)if(key!="ca"&&key!="cert"&&key!="key"&&key!="servers"&&key!="voiceBypass"&&key!="standby")throw new Exception("CS_WORKER_INPUT");
        var result=new Settings {Ca=Cert(Text(input,"ca",20000),true),Cert=Cert(Text(input,"cert",20000),false),
            Key=Pem(Text(input,"key",20000),"PRIVATE KEY"),Servers=new List<Candidate>()};
        object standby;if(input.TryGetValue("standby",out standby)){if(!(standby is bool))throw new Exception("CS_WORKER_INPUT");result.Standby=(bool)standby;}
        if(result.Standby&&!input.ContainsKey("voiceBypass"))throw new Exception("CS_VOICE_ENDPOINT");
        object bypass;if(input.TryGetValue("voiceBypass",out bypass)){
            var voice=bypass as Dictionary<string,object>;if(voice==null||voice.Count!=2)throw new Exception("CS_VOICE_ENDPOINT");
            string ip=Text(voice,"ip",15);object port;if(!voice.TryGetValue("port",out port)||!(port is int)||(int)port<1||(int)port>65535||!PublicIp(ip))throw new Exception("CS_VOICE_ENDPOINT");
            result.VoiceIp=ip;result.VoicePort=(int)port;
        }
        var servers=input["servers"] as IEnumerable;if(servers==null)throw new Exception("CS_WORKER_INPUT");
        foreach(var item in servers) {
            var server=item as Dictionary<string,object>;if(server==null||result.Servers.Count>=4)throw new Exception("CS_WORKER_INPUT");
            foreach(var key in server.Keys)if(key!="ip"&&key!="port"&&key!="country"&&key!="tcp")throw new Exception("CS_WORKER_INPUT");
            string ip=Text(server,"ip",15),country=Text(server,"country",2);object port;
            if(!server.TryGetValue("port",out port)||!(port is int)||((int)port)<1||((int)port)>65535||!PublicIp(ip)||!Regex.IsMatch(country,"\\A[A-Z]{2}\\z")||country=="BR")throw new Exception("CS_WORKER_INPUT");
            object tcp;bool supportsTcp=server.TryGetValue("tcp",out tcp)&&tcp is bool&&(bool)tcp;
            result.Servers.Add(new Candidate {Ip=ip,Port=(int)port,Country=country,Tcp=supportsTcp});
        }
        if(result.Servers.Count==0)throw new Exception("CS_WORKER_INPUT");return result;
    }
    static DirectorySecurity ProtectedAcl() {
        var acl=new DirectorySecurity();acl.SetAccessRuleProtection(true,false);acl.SetOwner(new SecurityIdentifier("S-1-5-32-544"));
        foreach(var sid in new[]{"S-1-5-18","S-1-5-32-544"})acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
        return acl;
    }
    static void CheckDirectory(string dir) {
        if((File.GetAttributes(dir)&FileAttributes.ReparsePoint)!=0)throw new Exception("CS_WORKER_DIRECTORY");
        var acl=Directory.GetAccessControl(dir);
        if(!acl.AreAccessRulesProtected)throw new Exception("CS_WORKER_DIRECTORY");
        foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier))) {
            string sid=rule.IdentityReference.Value;
            if(rule.AccessControlType==AccessControlType.Allow&&sid!="S-1-5-18"&&sid!="S-1-5-32-544")throw new Exception("CS_WORKER_DIRECTORY");
        }
    }
    static string Hash(byte[] data){using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(data)).Replace("-","").ToLowerInvariant();}
    static void Extract() {
        string root=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),"CallShareVpn");
        Directory.CreateDirectory(root,ProtectedAcl());CheckDirectory(root);
        RuntimeDir=Path.Combine(root,"runtime-"+"__RUNTIME_ID__");Directory.CreateDirectory(RuntimeDir,ProtectedAcl());CheckDirectory(RuntimeDir);
        foreach(var pair in Hashes) {
            string target=Path.Combine(RuntimeDir,pair.Key);
            if(File.Exists(target)) {if((File.GetAttributes(target)&FileAttributes.ReparsePoint)!=0||Hash(File.ReadAllBytes(target))!=pair.Value)throw new Exception("CS_WORKER_RUNTIME");continue;}
            using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("runtime."+pair.Key)) {
                if(stream==null)throw new Exception("CS_WORKER_RUNTIME");
                var memory=new MemoryStream();stream.CopyTo(memory);byte[] data=memory.ToArray();if(Hash(data)!=pair.Value)throw new Exception("CS_WORKER_RUNTIME");
                using(var output=new FileStream(target,FileMode.CreateNew,FileAccess.Write,FileShare.None))output.Write(data,0,data.Length);
            }
        }
        SessionDir=Path.Combine(root,"session-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(SessionDir,ProtectedAcl());CheckDirectory(SessionDir);
    }
    static ProcessStartInfo Info(string exe,string arguments) {
        return new ProcessStartInfo(exe,arguments){UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden,
            WorkingDirectory=RuntimeDir,RedirectStandardOutput=true,RedirectStandardError=true};
    }
    static string Tool(string exe,string arguments,int timeout) {
        using(var process=new Process()){process.StartInfo=Info(exe,arguments);var output=new StringBuilder();
            process.OutputDataReceived+=delegate(object sender,DataReceivedEventArgs ev){if(ev.Data!=null&&output.Length<16384)output.AppendLine(ev.Data);};
            process.ErrorDataReceived+=delegate(object sender,DataReceivedEventArgs ev){};
            process.Start();process.BeginOutputReadLine();process.BeginErrorReadLine();
            if(!process.WaitForExit(timeout)){process.Kill();process.WaitForExit();throw new Exception("CS_WORKER_TOOL_TIMEOUT");}
            process.WaitForExit();if(process.ExitCode!=0)throw new Exception("CS_WORKER_TOOL");return output.ToString();
        }
    }
    static string BuildProfile(Settings settings) {
        // Level 1 permits Windows' built-in network tools (for example netsh),
        // while continuing to prohibit user-defined scripts. Level 0 can prevent
        // configuring an actual Windows adapter even after TLS has succeeded.
        var text=new StringBuilder("client\ndev tun\nwindows-driver ovpn-dco\nnobind\nremote-cert-tls server\nauth SHA512\ndata-ciphers AES-256-GCM\ntls-version-min 1.2\ntls-cipher TLS-ECDHE-ECDSA-WITH-AES-256-GCM-SHA384\nkeepalive 10 30\nscript-security 1\nauth-nocache\nverb 3\npull-filter ignore \"redirect-gateway\"\npull-filter ignore \"route \"\npull-filter ignore \"route-ipv6\"\npull-filter ignore \"dhcp-option\"\npull-filter ignore \"dns \"\npull-filter ignore \"block-outside-dns\"\npull-filter ignore \"ifconfig-ipv6\"\nroute 0.0.0.0 0.0.0.0 vpn_gateway 60000\nserver-poll-timeout 15\nconnect-timeout 10\nconnect-retry-max 1\n");
        foreach(var s in settings.Servers)text.AppendFormat("remote {0} {1} udp4\n",s.Ip,s.Port);
        int fallbacks=0;foreach(var s in settings.Servers)if(s.Tcp&&fallbacks++<2)text.AppendFormat("remote {0} {1} tcp4-client\n",s.Ip,s.Port);
        // OpenVPN 2.7.8 compares --dev-node with NetCfgInstanceId using strcmp.
        // Keep the registry spelling (including case), while AdapterId remains
        // a normalized GUID for ownership and route checks.
        if(AdapterSelector==null)throw new Exception("CS_WORKER_ADAPTER");
        text.AppendFormat("dev-node {0}\n",AdapterSelector);
        text.Append("<ca>\n"+settings.Ca+"</ca>\n<cert>\n"+settings.Cert+"</cert>\n<key>\n"+settings.Key+"</key>\n");
        return text.ToString();
    }
    static void ObserveNative(string line) {
        if(line==null)return;
        string reason=null,marker=null;string lower=line.ToLowerInvariant();
        if(lower.Contains("options error:"))reason="options";
        else if(lower.Contains("verify error")||lower.Contains("certificate verify failed"))reason="certificate";
        else if(lower.Contains("auth_failed"))reason="authentication";
        else if(lower.Contains("cannot load")&&(lower.Contains("key")||lower.Contains("certificate")))reason="identity";
        else if(lower.Contains("no tap-windows or ovpn-dco adapters")||lower.Contains("adapter")&&lower.Contains("not found"))reason="adapter-missing";
        else if(lower.Contains("createfile failed on")||lower.Contains("failed to open")&&lower.Contains("adapter"))reason="adapter-open";
        else if(lower.Contains("unable to get adapter index"))reason="adapter-index";
        else if(lower.Contains("deviceiocontrol")&&lower.Contains("failed"))reason="driver-io";
        else if(lower.Contains("exit event")&&lower.Contains("signaled"))reason="exit-event";
        else if(lower.Contains("tls error:"))reason="handshake";
        else if(lower.Contains("netsh")&&(lower.Contains("error")||lower.Contains("failed")))reason="network-config";
        if(lower.Contains("driver is missing"))marker="driver-missing";
        else if(lower.Contains("dco version:"))marker="driver-version";
        else if(lower.Contains("verify ok"))marker="certificate-verified";
        else if(lower.Contains("peer connection initiated"))marker="peer-authenticated";
        else if(lower.Contains("push_reply"))marker="configuration-received";
        else if(lower.Contains("initialization sequence completed"))marker="initialized";
        else if(lower.Contains("exiting due to fatal error"))marker="fatal-exit";
        lock(Gate){if(reason!=null){NativeReason=reason;NativeMarkers.Add(reason);}if(marker!=null)NativeMarkers.Add(marker);}
    }
    static string NativeFailureCode() {
        if(NativeReason=="options")return "CS_VPN_CONFIG";
        if(NativeReason=="certificate"||NativeReason=="handshake")return "CS_VPN_TLS";
        if(NativeReason=="authentication")return "CS_VPN_AUTH";
        if(NativeReason=="identity")return "CS_VPN_IDENTITY";
        if(NativeReason=="adapter-missing"||NativeReason=="adapter-open"||NativeReason=="adapter-index")return "CS_VPN_ADAPTER";
        if(NativeReason=="driver-io")return "CS_VPN_DCO";
        return "CS_VPN_EXIT";
    }
    static bool AdapterRegistered() {
        foreach(var nic in NetworkInterface.GetAllNetworkInterfaces()) {
            Guid id;if(Guid.TryParse(nic.Id,out id)&&id.ToString("B")==AdapterId)
                try{return nic.GetIPProperties().GetIPv4Properties().Index>0;}catch{return false;}
        }
        return false;
    }
    static string AddressStateName(DuplicateAddressDetectionState value){switch(value){
        case DuplicateAddressDetectionState.Preferred:return "preferred";
        case DuplicateAddressDetectionState.Tentative:return "tentative";
        case DuplicateAddressDetectionState.Duplicate:return "duplicate";
        case DuplicateAddressDetectionState.Deprecated:return "deprecated";
        default:return "invalid";
    }}
    static bool UsableSource(IPAddress address,DuplicateAddressDetectionState state){
        if(address.AddressFamily!=System.Net.Sockets.AddressFamily.InterNetwork||IPAddress.IsLoopback(address)||address.Equals(IPAddress.Any)||state!=DuplicateAddressDetectionState.Preferred)return false;
        var bytes=address.GetAddressBytes();return bytes[0]<224&&!(bytes[0]==169&&bytes[1]==254);
    }
    static IPAddress OwnedAddress(bool requireReady=false){
        AddressState="missing";
        foreach(var nic in NetworkInterface.GetAllNetworkInterfaces()) {
            Guid id;if(!Guid.TryParse(nic.Id,out id)||id.ToString("B")!=AdapterId)continue;
            OwnedIndex=nic.GetIPProperties().GetIPv4Properties().Index;
            foreach(var entry in nic.GetIPProperties().UnicastAddresses)
                if(entry.Address.AddressFamily==System.Net.Sockets.AddressFamily.InterNetwork&&!IPAddress.IsLoopback(entry.Address)&&!entry.Address.Equals(IPAddress.Any)&&
                    !(entry.Address.GetAddressBytes()[0]==169&&entry.Address.GetAddressBytes()[1]==254)){
                    AddressState=AddressStateName(entry.DuplicateAddressDetectionState);
                    if(!requireReady||UsableSource(entry.Address,entry.DuplicateAddressDetectionState))return entry.Address;
                }
        }
        return null;
    }
    static string MatchAdapterSelector(string ownedId,string registeredId,string component) {
        Guid owned,registered;
        if(!Guid.TryParse(ownedId,out owned)||registeredId==null||
            !Regex.IsMatch(registeredId,"\\A\\{[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}\\}\\z")||
            !Guid.TryParse(registeredId,out registered)||owned!=registered||
            !String.Equals(component,"ovpn-dco",StringComparison.OrdinalIgnoreCase))return null;
        return registeredId;
    }
    static string FindAdapterSelector() {
        using(var root=Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Class\{4d36e972-e325-11ce-bfc1-08002be10318}",false)) {
            if(root==null)return null;
            foreach(string name in root.GetSubKeyNames())using(var key=root.OpenSubKey(name,false)) {
                if(key==null)continue;
                var selector=MatchAdapterSelector(AdapterId,key.GetValue("NetCfgInstanceId") as string,key.GetValue("ComponentId") as string);
                if(selector!=null)return selector;
            }
        }
        return null;
    }
    static void WaitForAdapter() {
        DateTime deadline=DateTime.UtcNow.AddSeconds(20);
        while(DateTime.UtcNow<deadline){
            CheckCancel();
            if(AdapterRegistered()&&(AdapterSelector=FindAdapterSelector())!=null){
                IntPtr handle=CreateFile("\\\\.\\ovpn-dco",0xC0000000,0,IntPtr.Zero,3,0x40000004,IntPtr.Zero);
                if(handle!=new IntPtr(-1)){CloseHandle(handle);lock(Gate)NativeMarkers.Add("adapter-ready");return;}
            }
            Thread.Sleep(250);
        }
        throw new Exception("CS_VPN_DRIVER_NOT_READY");
    }
    static void Run(Settings settings) {
        try {
            State("extracting");Extract();CheckCancel();State("driver");
            Tool(Path.Combine(Environment.SystemDirectory,"pnputil.exe"),"/add-driver \""+Path.Combine(RuntimeDir,"ovpn-dco.inf")+"\"",45000);
            CheckCancel();
            string created=Tool(Path.Combine(RuntimeDir,"tapctl.exe"),"create --hwid ovpn-dco --name \"CallShare "+Token.Substring(0,8)+"\"",15000);
            var match=Regex.Match(created,"\\{[a-fA-F0-9-]{36}\\}");if(!match.Success)throw new Exception("CS_WORKER_ADAPTER");
            AdapterId=new Guid(match.Value).ToString("B");CheckCancel();State("adapter");WaitForAdapter();
            OwnedAddress();if(OwnedIndex<=0)throw new Exception("CS_WORKER_ADAPTER");
            State("isolating");var targets=DiscordTargets.Find(UserSid);
            TargetPaths=targets;
            lock(Gate){NetworkBefore=NetworkDiagnostics.Capture(targets,OwnedIndex,null,null);NetworkBefore.stage="before-router";NetworkSnapshot=NetworkBefore;}
            DriverPreflight.AssertIdle();
            if(!ScopedSocks.CanReadUdpOwners())throw new Exception("CS_UDP_OWNER_TABLE");
            Isolation=new SplitGuard(OwnedIndex,IPAddress.Any);
            Tool(Path.Combine(Environment.SystemDirectory,"netsh.exe"),"interface ipv4 set interface interface="+OwnedIndex+" metric=5000",15000);
            string config=Path.Combine(SessionDir,"connection.ovpn");File.WriteAllText(config,BuildProfile(settings),new UTF8Encoding(false));
            var eventSecurity=new EventWaitHandleSecurity();
            foreach(var sid in new[]{"S-1-5-18","S-1-5-32-544"})eventSecurity.AddAccessRule(new EventWaitHandleAccessRule(new SecurityIdentifier(sid),EventWaitHandleRights.FullControl,AccessControlType.Allow));
            bool existed;string eventName="Local\\CallShareVPN-"+Token.Substring(0,24);
            ExitEvent=new EventWaitHandle(false,EventResetMode.ManualReset,eventName,out existed,eventSecurity);
            var initialized=new ManualResetEventSlim(false);DateTime start=DateTime.UtcNow,verifyStarted=DateTime.MaxValue;
            State("connecting");
            Child=new Process {StartInfo=Info(Path.Combine(RuntimeDir,"openvpn.exe"),"--config \""+config+"\" --service \""+eventName+"\" 0")};
            DataReceivedEventHandler onLine=delegate(object sender,DataReceivedEventArgs ev){
                if(ev.Data==null)return;
                // Raw output is never written to disk or returned over IPC.
                ObserveNative(ev.Data);
                if(ev.Data.Contains("Initialization Sequence Completed")){lock(Gate){ErrorCode=null;NativeReason=null;}initialized.Set();}
                if(ev.Data.Contains("Peer Connection Initiated"))foreach(var server in settings.Servers)if(ev.Data.Contains(server.Ip))Country=server.Country;
                if(ev.Data.Contains("VERIFY ERROR")||ev.Data.Contains("certificate verify failed"))ErrorCode="CS_VPN_TLS";
            };
            Job=CreateKillJob();
            Child.OutputDataReceived+=onLine;Child.ErrorDataReceived+=onLine;Child.Start();ChildStarted=true;
            if(!AssignProcessToJobObject(Job,Child.Handle)){Child.Kill();throw new Exception("CS_WORKER_JOB");}
            Child.BeginOutputReadLine();Child.BeginErrorReadLine();
            while(!Child.HasExited) {
                CheckCancel();
                if(initialized.IsSet){if(verifyStarted==DateTime.MaxValue)verifyStarted=DateTime.UtcNow;
                    var routeProof=Isolation.InspectRoutes();bool present=routeProof.tunnelPresent&&routeProof.normalPreserved;
                    if(!present&&(RoutesVerified||(DateTime.UtcNow-verifyStarted).TotalSeconds>15))throw new Exception("CS_ISOLATION_ROUTES");
                    if(present){
                        if(!Isolated){State("address");var address=OwnedAddress(true);if(address!=null){Proxy=new ScopedSocks(address,OwnedIndex,Token);Router=new ProcessRouter();Router.Start(RuntimeDir,targets,Proxy.Port,Token,settings.VoiceIp,settings.VoicePort,RequestedRouting);Isolated=true;}}
                        if(!Isolated&&(DateTime.UtcNow-verifyStarted).TotalSeconds>15)throw new Exception("CS_VPN_ADDRESS_NOT_READY");
                        if(Isolated){
                            if(Router.Active!=RequestedRouting){Router.SetActive(RequestedRouting);LastNetworkSnapshot=DateTime.MinValue;}
                            if(!Router.VoiceVerified)throw new Exception("CS_VOICE_FILTER");
                            if((DateTime.UtcNow-LastNetworkSnapshot).TotalSeconds>=3){
                                if(!Router.Active)DriverPreflight.AssertIdle(false);
                                var network=NetworkDiagnostics.Capture(targets,OwnedIndex,Proxy.Ledger,Router.VoiceProof,Proxy.UdpRelaySnapshot());
                                network.stage=Router.Active?"active":"standby";
                                lock(Gate)NetworkSnapshot=network;LastNetworkSnapshot=DateTime.UtcNow;
                            }
                            RoutesVerified=true;State("connected");
                        }
                    }}
                else if((DateTime.UtcNow-start).TotalSeconds>125)throw new Exception("CS_VPN_TIMEOUT");
                Thread.Sleep(400);
            }
            // WaitForExit() also drains asynchronous stdout/stderr. Without this,
            // an early fatal exit can be reported before its reason is observed.
            Child.WaitForExit();lock(Gate)NativeExitCode=Child.ExitCode;
            if(!Cancelled)throw new Exception(ErrorCode??NativeFailureCode());
        }catch(Exception error){if(!Cancelled){FailureStage=Stage;ErrorCode=Regex.IsMatch(error.Message,"\\ACS_[A-Z_]+\\z")?error.Message:"CS_WORKER_INTERNAL";State("failed");}}
        finally {
            State("stopping");bool clean=Cleanup();
            if(TargetPaths!=null)try{
                var after=NetworkDiagnostics.Capture(TargetPaths,OwnedIndex,Proxy==null?null:Proxy.Ledger,null,Proxy==null?null:Proxy.UdpRelaySnapshot());
                after.stage=clean?"after-stop":"cleanup-failed";
                lock(Gate)NetworkSnapshot=after;
            }catch{}
            lock(Gate){Cleaned=clean;RoutesVerified=false;Stage=clean?(ErrorCode==null?"stopped":"failed"):"cleanup-failed";Done=true;CompletedAt=DateTime.UtcNow;}
        }
    }
    static bool Cleanup() {
        bool clean=true;
        try{if(Router!=null)Router.Dispose();}catch{clean=false;}
        // SDK Stop's boolean does not prove all adapters were restored. Query modes.
        // Static rules are released when the native singleton exits with this worker.
        try{if(Router!=null)DriverPreflight.AssertIdle(false);}catch{clean=false;}
        try{if(Proxy!=null)Proxy.Dispose();}catch{clean=false;}
        Isolated=false;
        if(Child!=null){if(ChildStarted)try{ExitEvent.Set();if(!Child.WaitForExit(10000)){Child.Kill();Child.WaitForExit(3000);}}catch{clean=false;}Child.Dispose();}
        if(AdapterId!=null){try{Tool(Path.Combine(RuntimeDir,"tapctl.exe"),"delete "+AdapterId,15000);
            DateTime deadline=DateTime.UtcNow.AddSeconds(5);while(OwnRoutesPresent()&&DateTime.UtcNow<deadline)Thread.Sleep(200);
            if(OwnRoutesPresent())clean=false;
        }catch{clean=false;}}
        if(SessionDir!=null){try{CheckDirectory(SessionDir);string config=Path.Combine(SessionDir,"connection.ovpn");if(File.Exists(config))File.Delete(config);Directory.Delete(SessionDir,false);}catch{clean=false;}}
        if(Isolation!=null)Isolation.Dispose();
        if(ExitEvent!=null)ExitEvent.Dispose();if(Job!=IntPtr.Zero){CloseHandle(Job);Job=IntPtr.Zero;}return clean;
    }
    [DllImport("iphlpapi.dll",SetLastError=true)] static extern int GetIpForwardTable(IntPtr table,ref int size,bool order);
    static bool OwnRoutesPresent() {
        if(OwnedIndex<=0)return false;
        foreach(var route in SplitGuard.Routes())if(route.Index==(uint)OwnedIndex)return true;
        return false;
    }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {public long PerProcess,PerJob;public uint Flags;public UIntPtr MinWorking,MaxWorking;public uint ActiveProcesses;public UIntPtr Affinity;public uint Priority,Scheduling;}
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes;}
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {public BasicLimits Basic;public IoCounters Io;public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory;}
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref ExtendedLimits info,uint length);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string name,uint access,uint sharing,IntPtr security,uint creation,uint flags,IntPtr template);
    static IntPtr CreateKillJob(){IntPtr job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw new Exception("CS_WORKER_JOB");
        var info=new ExtendedLimits();info.Basic.Flags=0x2000;
        if(!SetInformationJobObject(job,9,ref info,(uint)Marshal.SizeOf(typeof(ExtendedLimits)))){CloseHandle(job);throw new Exception("CS_WORKER_JOB");}return job;}
    static void SelfTest() {
        SplitGuard.SelfTest();DiscordTargets.SelfTest();ScopedSocks.SelfTest();DriverPreflight.SelfTest();VoicePass.SelfTest();NetworkDiagnostics.SelfTest();InterfaceDiagnostics.SelfTest();PacketModeGate.SelfTest();ProcessRouter.SelfTest();
        foreach(var state in new[]{DuplicateAddressDetectionState.Tentative,DuplicateAddressDetectionState.Duplicate,DuplicateAddressDetectionState.Invalid,DuplicateAddressDetectionState.Deprecated})
            if(UsableSource(IPAddress.Parse("10.8.0.2"),state))throw new Exception("Tentative VPN source accepted");
        if(!UsableSource(IPAddress.Parse("10.8.0.2"),DuplicateAddressDetectionState.Preferred)||UsableSource(IPAddress.Any,DuplicateAddressDetectionState.Preferred)||
            UsableSource(IPAddress.Loopback,DuplicateAddressDetectionState.Preferred))throw new Exception("VPN source readiness regression");
        if(PublicIp("127.0.0.1")||PublicIp("10.1.1.1")||PublicIp("8.8.8.8 --up evil")||!PublicIp("8.8.8.8"))throw new Exception();
        if(!FixedEquals("abc","abc")||FixedEquals("abc","abd"))throw new Exception();
        try{Pem("-----BEGIN PRIVATE KEY-----\nMDA=\n-----END PRIVATE KEY-----\nup evil","PRIVATE KEY");throw new Exception("bad");}catch(Exception e){if(e.Message=="bad")throw;}
        var s=new Settings {Ca="CA",Cert="CERT",Key="KEY",Servers=new List<Candidate>{new Candidate{Ip="8.8.8.8",Port=1194,Country="US"}}};
        AdapterId="{a1b2c3d4-1234-abcd-5678-001122334455}";
        const string registered="{A1B2C3D4-1234-ABCD-5678-001122334455}";
        AdapterSelector=MatchAdapterSelector(AdapterId,registered,"ovpn-dco");
        if(AdapterSelector!=registered||String.Equals(AdapterId,AdapterSelector,StringComparison.Ordinal))throw new Exception("selector case regression");
        if(MatchAdapterSelector(AdapterId,"{FFFFFFFF-1234-ABCD-5678-001122334455}","ovpn-dco")!=null||
            MatchAdapterSelector(AdapterId,registered,"tap0901")!=null||
            MatchAdapterSelector(AdapterId,registered+"\nup malicious","ovpn-dco")!=null)throw new Exception("selector ownership regression");
        string profile=BuildProfile(s);
        if(!profile.Contains("dev-node "+registered+"\n")||profile.Contains("dev-node "+AdapterId+"\n"))throw new Exception("profile selector regression");
        if(!profile.Contains("script-security 1")||!profile.Contains("windows-driver ovpn-dco")||profile.Contains("redirect-gateway def1")||!profile.Contains("vpn_gateway 60000")||profile.Contains("plugin "))throw new Exception();
        IntPtr job=CreateKillJob();CloseHandle(job);
        int routeSize=0;int routeResult=GetIpForwardTable(IntPtr.Zero,ref routeSize,false);
        if(routeResult!=122||routeSize<4)throw new Exception("route table is not readable");
        ObserveNative("Options error: private-token C:\\secret\\profile.ovpn");
        if(NativeReason!="options"||NativeFailureCode()!="CS_VPN_CONFIG"||NativeMarkers.Count!=1||!NativeMarkers.Contains("options"))throw new Exception();
        ObserveNative("There are no TAP-Windows or ovpn-dco adapters on this system.");
        if(NativeReason!="adapter-missing"||NativeFailureCode()!="CS_VPN_ADAPTER")throw new Exception();
        ObserveNative("private-token 10.0.0.1 unrelated error text");
        if(NativeReason!="adapter-missing"||NativeMarkers.Count!=2)throw new Exception();
        NativeReason=null;NativeMarkers.Clear();
        using(var probe=new Process()){
            probe.StartInfo=new ProcessStartInfo(Assembly.GetExecutingAssembly().Location,"--self-test-output"){
                UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden,RedirectStandardOutput=true,RedirectStandardError=true};
            DataReceivedEventHandler observe=delegate(object sender,DataReceivedEventArgs ev){ObserveNative(ev.Data);};
            probe.OutputDataReceived+=observe;probe.ErrorDataReceived+=observe;probe.Start();probe.BeginOutputReadLine();probe.BeginErrorReadLine();
            if(!probe.WaitForExit(5000)){probe.Kill();throw new Exception();}probe.WaitForExit();
            if(probe.ExitCode!=23||NativeReason!="options"||NativeMarkers.Count!=1)throw new Exception();
        }
        Console.WriteLine("worker-self-test: passed");
    }
}
