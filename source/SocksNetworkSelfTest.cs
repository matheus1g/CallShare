using System;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
internal static class SocksNetworkSelfTest {
    static byte[] Read(Socket socket,int n){var b=new byte[n];int at=0;while(at<n){int count=socket.Receive(b,at,n-at,SocketFlags.None);if(count==0)throw new Exception();at+=count;}return b;}
    static void Write(Socket socket,byte[] bytes){foreach(byte value in bytes)socket.Send(new byte[]{value});}
    static Socket Client(int port){var s=new Socket(AddressFamily.InterNetwork,SocketType.Stream,ProtocolType.Tcp);s.ReceiveTimeout=5000;s.Connect(IPAddress.Loopback,port);return s;}
    static void Authenticate(Socket s,string secret){Write(s,new byte[]{5,2,0,2});var hello=Read(s,2);if(hello[1]!=2)throw new Exception();
        byte[] user=Encoding.ASCII.GetBytes("callshare"),pass=Encoding.ASCII.GetBytes(secret);Write(s,new byte[]{1,(byte)user.Length});Write(s,user);Write(s,new byte[]{(byte)pass.Length});Write(s,pass);}
    static void ErrorReplies(){
        foreach(var item in new[]{new[]{10049,1},new[]{10013,2},new[]{10051,3},new[]{10065,4},new[]{10061,5},new[]{10060,4}}){
            int native=item[0],expected=item[1];string password=new string('a',64);
            using(var proxy=new ScopedSocks(IPAddress.Loopback,1,password,delegate(IPAddress ip,int port){throw new ScopedSocks.DialFailure(native==10049?"bind":"connect",new SocketException(native));}))
            using(var client=Client(proxy.Port)){
                Authenticate(client,password);if(Read(client,2)[1]!=0)throw new Exception();Write(client,new byte[]{5,1,0,1,1,1,1,1,1,187});
                if(Read(client,10)[1]!=expected)throw new Exception("SOCKS error classification: "+native);
            }
        }
    }
    public static void Run(){
        ErrorReplies();
        // Exercises the production Bind/IP_UNICAST_IF path on loopback, without
        // making an outbound connection, changing any routes, or starting a VPN.
        using(var bound=new ScopedSocks(IPAddress.Loopback,1,new string('a',64))){
            if(ScopedSocks.StartupDiagnostic==null||ScopedSocks.StartupDiagnostic.stage!="ready")throw new Exception("Production bind/interface check failed");
        }
        var echo=new TcpListener(IPAddress.Loopback,0);echo.Start();int echoPort=((IPEndPoint)echo.LocalEndpoint).Port;
        var thread=new Thread(delegate(){try{using(var s=echo.AcceptSocket()){var b=new byte[32768];int n;while((n=s.Receive(b))>0){int at=0;while(at<n)at+=s.Send(b,at,n-at,SocketFlags.None);}}}catch{}}){IsBackground=true};thread.Start();
        string password=new string('a',64);int dials=0;
        using(var proxy=new ScopedSocks(IPAddress.Loopback,1,password,delegate(IPAddress ip,int port){
            if(ip.ToString()!="1.1.1.1"||port!=443)throw new Exception();Interlocked.Increment(ref dials);
            var s=new Socket(AddressFamily.InterNetwork,SocketType.Stream,ProtocolType.Tcp);s.Connect(IPAddress.Loopback,echoPort);return s;
        }))try{
            using(var c=Client(proxy.Port)){Write(c,new byte[]{5,1,0});if(Read(c,2)[1]!=255)throw new Exception("unauthenticated accepted");}
            using(var c=Client(proxy.Port)){Authenticate(c,new string('b',64));if(Read(c,2)[1]!=1)throw new Exception("wrong password accepted");}
            using(var c=Client(proxy.Port)){Authenticate(c,password);if(Read(c,2)[1]!=0)throw new Exception();Write(c,new byte[]{5,1,0,1,127,0,0,1,1,187});if(Read(c,10)[1]!=2||dials!=0)throw new Exception("private address accepted");}
            using(var c=Client(proxy.Port)){Authenticate(c,password);if(Read(c,2)[1]!=0)throw new Exception();Write(c,new byte[]{5,1,0,1,1,1,1,1,1,187});if(Read(c,10)[1]!=0)throw new Exception();
                var payload=new byte[16384];for(int i=0;i<payload.Length;i++)payload[i]=(byte)(i%251);int at=0;while(at<payload.Length)at+=c.Send(payload,at,payload.Length-at,SocketFlags.None);
                var result=Read(c,payload.Length);for(int i=0;i<result.Length;i++)if(result[i]!=payload[i])throw new Exception("relay changed payload");
            }
            if(dials!=1||proxy.TcpConnections!=1)throw new Exception();
            using(var udp=new Socket(AddressFamily.InterNetwork,SocketType.Dgram,ProtocolType.Udp)){udp.Bind(new IPEndPoint(IPAddress.Loopback,0));
                DateTime deadline=DateTime.UtcNow.AddSeconds(1);bool found=false;while(DateTime.UtcNow<deadline){if(ScopedSocks.OwnUdpPort(((IPEndPoint)udp.LocalEndPoint).Port)){found=true;break;}Thread.Sleep(50);}
                if(!found){if(ScopedSocks.UdpTableError==5){Console.Error.WriteLine("TCP relay, SOCKS error mapping and production local Bind/interface checks passed; UDP owner table requires the installed privileged service on this host.");return;}
                    throw new Exception("UDP owner lookup: status="+ScopedSocks.UdpTableError);}}
        }finally{echo.Stop();thread.Join(1000);}
    }
}
