// Original local SOCKS5 relay. Only its authenticated clients can use the owned VPN interface.
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.Runtime.InteropServices;

internal sealed class ScopedSocks : IDisposable {
    internal sealed class Diagnostic {
        public string stage,category;
        public int? nativeCode;
        public int attempts,addresses;
        public int socksReply;
    }
    internal sealed class DialFailure : Exception {
        public readonly string Stage;
        public DialFailure(string stage,Exception error):base("CS_PROXY_SOCKET",error){Stage=stage;}
    }
    // Fixed counters only. Retain no addresses, ports, datagrams or exception text.
    sealed class UdpRelayCounters {
        internal long AssociateRequests,AssociationsReady,LocalDatagrams,InvalidDatagrams,OwnerRejected,DestinationRejected;
        internal long SetupErrors,SendErrors,ReplyErrors,Sent,Replies,LastOwnerTableError;
        int lastSocketError;
        internal bool RecordFailure(Exception error,bool polling=false){
            var wrapped=error as DialFailure;
            if(wrapped!=null)error=wrapped.InnerException;
            if(error is ObjectDisposedException)return false;
            var socket=error as SocketException;
            if(socket==null)return true;
            switch(socket.SocketErrorCode){
                case SocketError.TimedOut:
                case SocketError.WouldBlock:
                    if(polling)return false;
                    break;
                case SocketError.Interrupted:
                case SocketError.OperationAborted:
                case SocketError.Shutdown:
                    return false;
            }
            if(socket.NativeErrorCode>0)Interlocked.Exchange(ref lastSocketError,socket.NativeErrorCode);
            return true;
        }
        internal Dictionary<string,long> Snapshot(){
            var snapshot=new Dictionary<string,long>{
                {"associateRequests",Interlocked.Read(ref AssociateRequests)},
                {"associationsReady",Interlocked.Read(ref AssociationsReady)},
                {"localDatagrams",Interlocked.Read(ref LocalDatagrams)},
                {"invalidDatagrams",Interlocked.Read(ref InvalidDatagrams)},
                {"ownerRejected",Interlocked.Read(ref OwnerRejected)},
                {"destinationRejected",Interlocked.Read(ref DestinationRejected)},
                {"setupErrors",Interlocked.Read(ref SetupErrors)},
                {"sendErrors",Interlocked.Read(ref SendErrors)},
                {"replyErrors",Interlocked.Read(ref ReplyErrors)},
                {"sent",Interlocked.Read(ref Sent)},
                {"replies",Interlocked.Read(ref Replies)}
            };
            int socketError=Interlocked.CompareExchange(ref lastSocketError,0,0);
            long ownerError=Interlocked.Read(ref LastOwnerTableError);
            if(socketError>0)snapshot.Add("lastSocketError",socketError);
            if(ownerError>0)snapshot.Add("lastOwnerTableError",ownerError);
            return snapshot;
        }
    }
    internal static Diagnostic StartupDiagnostic;
    volatile Diagnostic gatewayDiagnostic;
    public Diagnostic GatewayDiagnostic{get{return gatewayDiagnostic??StartupDiagnostic;}}
    readonly IPAddress localAddress;
    readonly int interfaceIndex;
    readonly string password;
    readonly TcpListener listener;
    readonly int boundPort;
    readonly object gate=new object();
    readonly HashSet<Socket> sockets=new HashSet<Socket>();
    readonly Func<IPAddress,int,Socket> dial;
    volatile bool stopped;
    int clients;
    public int Port{get{return boundPort;}}
    public long TcpConnections;
    readonly UdpRelayCounters udpRelay=new UdpRelayCounters();
    public long UdpPackets{get{return Interlocked.Read(ref udpRelay.Sent);}}
    public object UdpRelaySnapshot(){return udpRelay.Snapshot();}
    public readonly RelayLedger Ledger=new RelayLedger();
    internal static uint UdpTableError;
    internal static bool CanReadUdpOwners(){int bytes=0;uint code=GetExtendedUdpTable(IntPtr.Zero,ref bytes,false,2,1,0);UdpTableError=code;return (code==0||code==122)&&bytes>=4;}
    public ScopedSocks(IPAddress address,int index,string secret,Func<IPAddress,int,Socket> testDial=null){
        if(address.AddressFamily!=AddressFamily.InterNetwork||index<1||secret.Length!=64)throw new Exception("CS_PROXY_INPUT");
        localAddress=address;interfaceIndex=index;password=secret;dial=testDial??Dial;
        // No internet connection is made here. Refuse readiness if binding the
        // assigned address or selecting its interface already fails locally.
        if(testDial==null)try{
            var tcp=NewVpnSocket(SocketType.Stream,ProtocolType.Tcp);Drop(tcp);
            var udp=NewVpnSocket(SocketType.Dgram,ProtocolType.Udp);Drop(udp);
            StartupDiagnostic=new Diagnostic{stage="ready"};
        }catch(Exception error){StartupDiagnostic=Describe(error,"create",0,0);throw new Exception("CS_PROXY_BIND");}
        listener=new TcpListener(IPAddress.Loopback,0);listener.Server.ExclusiveAddressUse=true;listener.Start(32);boundPort=((IPEndPoint)listener.LocalEndpoint).Port;
        new Thread(Accept){IsBackground=true}.Start();
    }
    void Accept(){while(!stopped)try{
        var client=listener.AcceptSocket();
        if(Interlocked.Increment(ref clients)>32){Interlocked.Decrement(ref clients);client.Close();continue;}
        Track(client);ThreadPool.QueueUserWorkItem(delegate(object unused){try{Handle(client);}catch{}finally{Drop(client);Interlocked.Decrement(ref clients);}});
    }catch{if(!stopped)Thread.Sleep(30);}}
    Socket Track(Socket socket){lock(gate){if(stopped){socket.Close();throw new IOException();}sockets.Add(socket);}return socket;}
    void Drop(Socket socket){lock(gate)sockets.Remove(socket);try{socket.Close();}catch{}}
    Socket NewVpnSocket(SocketType type,ProtocolType protocol){
        Socket socket=null;string stage="create";
        try{socket=Track(new Socket(AddressFamily.InterNetwork,type,protocol));stage="bind";socket.Bind(new IPEndPoint(localAddress,0));stage="interface";
            socket.SetSocketOption(SocketOptionLevel.IP,(SocketOptionName)31,IPAddress.HostToNetworkOrder(interfaceIndex));
            // Windows returns IP_UNICAST_IF in host byte order on getsockopt.
            if((int)socket.GetSocketOption(SocketOptionLevel.IP,(SocketOptionName)31)!=interfaceIndex)throw new SocketException((int)SocketError.InvalidArgument);
            return socket;
        }catch(Exception error){if(socket!=null)Drop(socket);throw new DialFailure(stage,error);}
    }
    Socket Dial(IPAddress address,int port){
        var socket=NewVpnSocket(SocketType.Stream,ProtocolType.Tcp);
        try{var pending=socket.BeginConnect(new IPEndPoint(address,port),null,null);
            if(!pending.AsyncWaitHandle.WaitOne(6000))throw new SocketException((int)SocketError.TimedOut);socket.EndConnect(pending);return socket;
        }catch(Exception error){Drop(socket);throw new DialFailure("connect",error);}
    }
    static byte[] Read(Socket socket,int count){
        var bytes=new byte[count];int at=0;while(at<count){int n=socket.Receive(bytes,at,count-at,SocketFlags.None);if(n==0)throw new IOException();at+=n;}return bytes;
    }
    static void Send(Socket socket,byte[] bytes){int at=0;while(at<bytes.Length){int n=socket.Send(bytes,at,bytes.Length-at,SocketFlags.None);if(n==0)throw new IOException();at+=n;}}
    static int U16(byte[] bytes,int offset){return (bytes[offset]<<8)|bytes[offset+1];}
    static byte[] Reply(int code,int port=0){return new byte[]{5,(byte)code,0,1,127,0,0,1,(byte)(port>>8),(byte)port};}
    static bool Equal(byte[] left,byte[] right){if(left.Length!=right.Length)return false;int difference=0;for(int i=0;i<left.Length;i++)difference|=left[i]^right[i];return difference==0;}
    internal static bool PublicAddress(IPAddress address){
        if(address.AddressFamily!=AddressFamily.InterNetwork)return false;
        var p=address.GetAddressBytes();int a=p[0],b=p[1],c=p[2];
        return a>0&&a<224&&a!=10&&a!=127&&!(a==100&&b>=64&&b<=127)&&!(a==169&&b==254)&&!(a==172&&b>=16&&b<=31)&&
            !(a==192&&(b==168||b==0&&(c==0||c==2)))&&!(a==198&&(b==18||b==19||b==51&&c==100))&&!(a==203&&b==0&&c==113);
    }
    static List<IPAddress> Resolve(string host){
        var result=new List<IPAddress>();IPAddress parsed;
        if(IPAddress.TryParse(host,out parsed)){if(PublicAddress(parsed))result.Add(parsed);return result;}
        if(host.Length>253||!System.Text.RegularExpressions.Regex.IsMatch(host,@"\A[a-zA-Z0-9][a-zA-Z0-9.\-]*[a-zA-Z0-9]\z"))return result;
        var pending=Dns.BeginGetHostAddresses(host,null,null);
        if(!pending.AsyncWaitHandle.WaitOne(8000))throw new SocketException((int)SocketError.TimedOut);
        foreach(var ip in Dns.EndGetHostAddresses(pending))if(PublicAddress(ip)&&!result.Contains(ip)){result.Add(ip);if(result.Count==3)break;}return result;
    }
    internal static Diagnostic Describe(Exception error,string fallback,int attempts,int addresses){
        var wrapped=error as DialFailure;string stage=wrapped==null?fallback:wrapped.Stage;
        Exception cause=wrapped==null?error:wrapped.InnerException;var socket=cause as SocketException;
        int? native=socket==null?(int?)null:socket.NativeErrorCode;
        string category="internal";int reply=1;
        if(stage=="resolve"){category="dns";reply=4;}
        if(socket!=null)switch(socket.SocketErrorCode){
            case SocketError.ConnectionRefused:if(stage=="connect"){category="refused";reply=5;}else{category="internal";reply=1;}break;
            case SocketError.AccessDenied:category="denied";reply=2;break;
            case SocketError.NetworkUnreachable:case SocketError.NetworkDown:category="network-unreachable";reply=3;break;
            case SocketError.HostUnreachable:case SocketError.HostDown:category="host-unreachable";reply=4;break;
            case SocketError.TimedOut:category="timeout";reply=4;break;
            case SocketError.AddressNotAvailable:category="local-address";reply=1;break;
        }
        return new Diagnostic{stage=stage,category=category,nativeCode=native,attempts=attempts,addresses=addresses,socksReply=reply};
    }
    void Handle(Socket client){
        client.ReceiveTimeout=15000;client.SendTimeout=15000;
        var hello=Read(client,2);if(hello[0]!=5||hello[1]==0)throw new IOException();
        var methods=Read(client,hello[1]);if(Array.IndexOf(methods,(byte)2)<0){Send(client,new byte[]{5,255});return;}
        Send(client,new byte[]{5,2});var auth=Read(client,2);if(auth[0]!=1)throw new IOException();
        var user=Read(client,auth[1]);int length=Read(client,1)[0];var secret=Read(client,length);
        bool accepted=Equal(user,Encoding.ASCII.GetBytes("callshare"))&&Equal(secret,Encoding.ASCII.GetBytes(password));Array.Clear(secret,0,secret.Length);
        Send(client,new byte[]{1,(byte)(accepted?0:1)});if(!accepted)return;
        var request=Read(client,4);if(request[0]!=5||request[2]!=0)throw new IOException();
        string host;
        if(request[3]==1)host=new IPAddress(Read(client,4)).ToString();
        else if(request[3]==3)host=Encoding.ASCII.GetString(Read(client,Read(client,1)[0]));
        else if(request[3]==4){Read(client,16);Read(client,2);Send(client,Reply(8));return;}
        else throw new IOException();
        int port=U16(Read(client,2),0);
        if(request[1]==3){UdpAssociate(client);return;}
        if(request[1]!=1||port==0){Send(client,Reply(7));return;}
        bool gateway=port==443&&String.Equals(host,"gateway.discord.gg",StringComparison.OrdinalIgnoreCase);
        List<IPAddress> targets;try{targets=Resolve(host);}catch(Exception error){var failure=Describe(error,"resolve",0,0);if(gateway)gatewayDiagnostic=failure;Send(client,Reply(failure.socksReply));return;}
        if(targets.Count==0){if(gateway)gatewayDiagnostic=new Diagnostic{stage="resolve",category="denied",socksReply=2};Send(client,Reply(2));return;}
        Socket remote=null;Diagnostic last=null;int attempts=0;
        foreach(var target in targets){
            if(stopped)return;attempts++;
            try{remote=Track(dial(target,port));break;}
            catch(Exception error){last=Describe(error,"connect",attempts,targets.Count);if(gateway)gatewayDiagnostic=last;
                // A local binding/interface/permission error is independent of DNS targets.
                if(last.stage!="connect"||last.category=="denied"||last.category=="local-address")break;
            }
        }
        if(remote==null){Send(client,Reply(last==null?1:last.socksReply));return;}
        if(gateway)gatewayDiagnostic=new Diagnostic{stage="connected",attempts=attempts,addresses=targets.Count};
        var remoteEndpoint=(IPEndPoint)remote.RemoteEndPoint;Ledger.Add("tcp",remoteEndpoint,0,true);
        try{Send(client,Reply(0));client.ReceiveTimeout=0;remote.ReceiveTimeout=0;Interlocked.Increment(ref TcpConnections);
            ThreadPool.QueueUserWorkItem(delegate(object unused){try{Copy(client,remote,remoteEndpoint,true);}catch{}finally{Drop(remote);Drop(client);}});
            try{Copy(remote,client,remoteEndpoint,false);}finally{Drop(remote);Drop(client);}
        }finally{Drop(remote);}
    }
    void Copy(Socket from,Socket to,IPEndPoint endpoint,bool outbound){var bytes=new byte[32768];int count;while((count=from.Receive(bytes))>0){int at=0;while(at<count){int n=to.Send(bytes,at,count-at,SocketFlags.None);if(n==0)throw new IOException();at+=n;Ledger.Add("tcp",endpoint,n,outbound);}}}
    void UdpAssociate(Socket control){
        Interlocked.Increment(ref udpRelay.AssociateRequests);
        Socket local=null,remote=null;
        Thread inbound=null,outbound=null;
        var closed=new volatileBox();
        bool ready=false;
        try{
            local=Track(new Socket(AddressFamily.InterNetwork,SocketType.Dgram,ProtocolType.Udp));
            remote=NewVpnSocket(SocketType.Dgram,ProtocolType.Udp);
            local.ExclusiveAddressUse=true;
            local.Bind(new IPEndPoint(IPAddress.Loopback,0));
            local.ReceiveTimeout=1000;
            remote.ReceiveTimeout=1000;
            IPEndPoint owner=null;
            var destinations=new HashSet<string>();
            var state=new object();
            inbound=new Thread(delegate(){
                var bytes=new byte[65535];
                while(!stopped&&!closed.Value){
                    bool polling=true;
                    try{
                        EndPoint source=new IPEndPoint(IPAddress.Any,0);
                        int size=remote.ReceiveFrom(bytes,ref source);
                        polling=false;
                        var endpoint=(IPEndPoint)source;
                        IPEndPoint target;
                        lock(state){target=owner;if(target==null||!destinations.Contains(endpoint.ToString()))continue;}
                        var data=new byte[10+size];
                        data[3]=1;
                        Array.Copy(endpoint.Address.GetAddressBytes(),0,data,4,4);
                        data[8]=(byte)(endpoint.Port>>8);
                        data[9]=(byte)endpoint.Port;
                        Array.Copy(bytes,0,data,10,size);
                        local.SendTo(data,target);
                        Interlocked.Increment(ref udpRelay.Replies);
                        Ledger.Add("udp",endpoint,size,false);
                    }catch(Exception error){
                        if(!stopped&&!closed.Value&&udpRelay.RecordFailure(error,polling))Interlocked.Increment(ref udpRelay.ReplyErrors);
                        if(!(error is SocketException))break;
                    }
                }
            }){IsBackground=true};
            outbound=new Thread(delegate(){
                var bytes=new byte[65535];
                while(!stopped&&!closed.Value){
                    bool sending=false;
                    try{
                        EndPoint source=new IPEndPoint(IPAddress.Any,0);
                        int size=local.ReceiveFrom(bytes,ref source);
                        Interlocked.Increment(ref udpRelay.LocalDatagrams);
                        var endpoint=(IPEndPoint)source;
                        if(!IPAddress.IsLoopback(endpoint.Address)||size<10||bytes[0]!=0||bytes[1]!=0||bytes[2]!=0||bytes[3]!=1){
                            Interlocked.Increment(ref udpRelay.InvalidDatagrams);continue;
                        }
                        lock(state){
                            if(owner==null){
                                uint ownerError;
                                if(!OwnUdpPort(endpoint.Port,out ownerError)){
                                    Interlocked.Increment(ref udpRelay.OwnerRejected);
                                    if(ownerError!=0)Interlocked.Exchange(ref udpRelay.LastOwnerTableError,ownerError);
                                    continue;
                                }
                                owner=endpoint;
                            }else if(!owner.Equals(endpoint)){
                                Interlocked.Increment(ref udpRelay.OwnerRejected);continue;
                            }
                        }
                        var ip=new IPAddress(new byte[]{bytes[4],bytes[5],bytes[6],bytes[7]});
                        int port=U16(bytes,8);
                        if(!PublicAddress(ip)||port==0){Interlocked.Increment(ref udpRelay.DestinationRejected);continue;}
                        var destination=new IPEndPoint(ip,port);
                        lock(state){
                            string key=destination.ToString();
                            if(destinations.Count>=128&&!destinations.Contains(key)){
                                Interlocked.Increment(ref udpRelay.DestinationRejected);continue;
                            }
                            destinations.Add(key);
                        }
                        sending=true;
                        int sent=remote.SendTo(bytes,10,size-10,SocketFlags.None,destination);
                        sending=false;
                        Interlocked.Increment(ref udpRelay.Sent);
                        Ledger.Add("udp",destination,sent,true);
                    }catch(Exception error){
                        if(!stopped&&!closed.Value&&udpRelay.RecordFailure(error,!sending)&&sending)Interlocked.Increment(ref udpRelay.SendErrors);
                        if(!(error is SocketException))break;
                    }
                }
            }){IsBackground=true};
            Send(control,Reply(0,((IPEndPoint)local.LocalEndPoint).Port));
            control.ReceiveTimeout=0;
            inbound.Start();
            outbound.Start();
            Interlocked.Increment(ref udpRelay.AssociationsReady);
            ready=true;
            var discard=new byte[1];while(!stopped&&control.Receive(discard)>0){}
        }catch(Exception error){
            if(!ready&&!stopped&&udpRelay.RecordFailure(error))Interlocked.Increment(ref udpRelay.SetupErrors);
            throw;
        }finally{
            closed.Value=true;
            if(local!=null)Drop(local);
            if(remote!=null)Drop(remote);
            if(inbound!=null&&inbound.IsAlive)inbound.Join(1500);
            if(outbound!=null&&outbound.IsAlive)outbound.Join(1500);
        }
    }
    sealed class volatileBox{public volatile bool Value;}
    internal static bool OwnUdpPort(int port){
        uint error;
        bool owned=OwnUdpPort(port,out error);
        UdpTableError=error;
        return owned;
    }
    static bool OwnUdpPort(int port,out uint error){
        int size=0;error=GetExtendedUdpTable(IntPtr.Zero,ref size,false,2,1,0);if(size<4||size>4*1024*1024)return false;
        IntPtr data=Marshal.AllocHGlobal(size);try{error=GetExtendedUdpTable(data,ref size,false,2,1,0);if(error!=0)return false;
            int count=Marshal.ReadInt32(data),pid=System.Diagnostics.Process.GetCurrentProcess().Id;if(count<0||count>(size-4)/12)return false;
            for(int i=0;i<count;i++){int at=4+i*12,raw=Marshal.ReadInt32(data,at+4);int candidate=((raw&255)<<8)|((raw>>8)&255);
                if(candidate==port&&Marshal.ReadInt32(data,at+8)==pid)return true;}return false;
        }finally{Marshal.FreeHGlobal(data);}
    }
    [DllImport("iphlpapi.dll")]static extern uint GetExtendedUdpTable(IntPtr table,ref int size,bool sorted,int family,int tableClass,uint reserved);
    public void ResetRelays(){Socket[] copy;lock(gate){copy=new Socket[sockets.Count];sockets.CopyTo(copy);sockets.Clear();}foreach(var socket in copy)try{socket.Close();}catch{}}
    public void Dispose(){stopped=true;listener.Stop();ResetRelays();}
    public static void SelfTest(){
        if(PublicAddress(IPAddress.Loopback)||PublicAddress(IPAddress.Parse("10.0.0.1"))||!PublicAddress(IPAddress.Parse("1.1.1.1"))||PublicAddress(IPAddress.IPv6Loopback))throw new Exception("Proxy address filter");
        if(U16(new byte[]{1,187},0)!=443||Equal(new byte[]{1},new byte[]{2}))throw new Exception("Proxy parsing");
        if(Describe(new DialFailure("bind",new SocketException(10049)),"connect",1,1).socksReply==5||
            Describe(new SocketException(10013),"connect",1,1).socksReply!=2||
            Describe(new SocketException(10051),"connect",1,1).socksReply!=3||
            Describe(new SocketException(10061),"connect",1,1).socksReply!=5||
            Describe(new SocketException(10060),"connect",1,1).category!="timeout"||
            Describe(new IOException("private-path"),"connect",1,1).socksReply==5)throw new Exception("Proxy error classification");
        var counters=new UdpRelayCounters();
        if(counters.RecordFailure(new SocketException((int)SocketError.TimedOut),true)||
            counters.RecordFailure(new ObjectDisposedException("test"))||counters.Snapshot().ContainsKey("lastSocketError"))
            throw new Exception("Ordinary UDP shutdown or timeout recorded as failure");
        if(!counters.RecordFailure(new SocketException((int)SocketError.TimedOut)))throw new Exception("UDP send timeout was ignored");
        if(counters.RecordFailure(new DialFailure("bind",new SocketException((int)SocketError.AccessDenied))))
            Interlocked.Increment(ref counters.SetupErrors);
        var snapshot=counters.Snapshot();
        if(snapshot["setupErrors"]!=1||snapshot["sent"]!=0||snapshot["lastSocketError"]!=(int)SocketError.AccessDenied||snapshot.ContainsKey("lastOwnerTableError"))
            throw new Exception("UDP setup failure counters");
    }
}
