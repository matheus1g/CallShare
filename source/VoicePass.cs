// Fixed UDP endpoint PASS rules, inserted before the SDK starts packet interception.
// ABI: pinned ProxiFyre include/Common.h, pack(1), STATIC_FILTER = 184 bytes.
using System;
using System.Net;
using System.Runtime.InteropServices;
internal sealed class VoicePass : IDisposable {
    internal sealed class Proof {public string ip,stage;public int port,filterCount;public uint nativeCode;public bool verified,matchesIn,matchesOut;public long packetsIn,packetsOut,bytesIn,bytesOut;}
    public static volatile Proof LastProof;
    readonly string ip;readonly int port;IntPtr driver=new IntPtr(-1);byte[] incoming,outgoing;
    public VoicePass(string address,int targetPort){ip=address;port=targetPort;incoming=Build(ip,port,false);outgoing=Build(ip,port,true);LastProof=new Proof{ip=ip,port=port,stage="requested"};}
    static uint Code(int op){return (0x8300u<<16)|((uint)(0x830+op)<<2);}
    internal static byte[] Build(string ip,int port,bool outbound){
        IPAddress parsed;if(!IPAddress.TryParse(ip,out parsed)||parsed.AddressFamily!=System.Net.Sockets.AddressFamily.InterNetwork||port<1||port>65535)throw new Exception("CS_VOICE_ENDPOINT");
        var b=new byte[184];Put(b,8,outbound?1:2);Put(b,12,1);Put(b,16,6);Put(b,80,1);Put(b,84,(outbound?2:1)|4);
        int address=outbound?100:88;Put(b,address,1);Array.Copy(parsed.GetAddressBytes(),0,b,address+4,4);Put(b,address+8,-1);b[112]=17;
        Put(b,164,1);Put(b,168,outbound?2:1);int range=outbound?176:172;var p=BitConverter.GetBytes((ushort)port);Array.Copy(p,0,b,range,2);Array.Copy(p,0,b,range+2,2);return b;
    }
    static void Put(byte[] b,int at,int value){Array.Copy(BitConverter.GetBytes(value),0,b,at,4);}
    public void Install(){
        driver=CreateFile(@"\\.\NDISRD",0,3,IntPtr.Zero,3,0,IntPtr.Zero);if(driver==new IntPtr(-1)){LastProof=new Proof{ip=ip,port=port,stage="open",nativeCode=(uint)Marshal.GetLastWin32Error()};throw new Exception("CS_VOICE_FILTER");}
        // SDK has configured its LAN/proxy exclusions but has NOT started interception.
        int which=0;foreach(var filter in new[]{incoming,outgoing}){uint returned;if(!DeviceIoControl(driver,Code(30),filter,filter.Length,null,0,out returned,IntPtr.Zero)){LastProof=new Proof{ip=ip,port=port,stage=which==0?"insert-in":"insert-out",nativeCode=(uint)Marshal.GetLastWin32Error()};throw new Exception("CS_VOICE_FILTER");}which++;}
        if(!Inspect().verified)throw new Exception("CS_VOICE_FILTER");
    }
    static bool Matches(byte[] table,int at,byte[] expected){for(int i=0;i<184;i++){if(i>=20&&i<56)continue;if(table[at+i]!=expected[i])return false;}return true;}
    public Proof Inspect(){
        var proof=new Proof{ip=ip,port=port,stage="read-size"};if(driver==new IntPtr(-1))return LastProof??proof;
        var count=new byte[4];uint returned;if(!DeviceIoControl(driver,Code(16),null,0,count,4,out returned,IntPtr.Zero)){proof.nativeCode=(uint)Marshal.GetLastWin32Error();return LastProof=proof;}
        int n=BitConverter.ToInt32(count,0);proof.filterCount=n;proof.stage="size";if(n<2||n>1024)return LastProof=proof;var table=new byte[8+n*184];Put(table,0,n);
        proof.stage="read-table";if(!DeviceIoControl(driver,Code(17),table,table.Length,table,table.Length,out returned,IntPtr.Zero)){proof.nativeCode=(uint)Marshal.GetLastWin32Error();return LastProof=proof;}
        if(BitConverter.ToInt32(table,0)!=n)return LastProof=proof;
        // They must be the first two filters; a prior broader rule would invalidate preservation.
        proof.stage="mismatch";proof.matchesOut=Matches(table,8,outgoing);proof.matchesIn=Matches(table,192,incoming);if(!proof.matchesOut||!proof.matchesIn)return LastProof=proof;
        proof.stage="verified";proof.verified=true;proof.packetsOut=ReadCounter(table,8+40);proof.bytesOut=ReadCounter(table,8+48);proof.packetsIn=ReadCounter(table,192+24);proof.bytesIn=ReadCounter(table,192+32);return LastProof=proof;
    }
    static long ReadCounter(byte[] b,int at){ulong value=BitConverter.ToUInt64(b,at);return value>long.MaxValue?long.MaxValue:(long)value;}
    public void Dispose(){if(driver!=new IntPtr(-1)){CloseHandle(driver);driver=new IntPtr(-1);}}
    public static void SelfTest(){var o=Build("8.9.10.11",50000,true);var i=Build("8.9.10.11",50000,false);if(o.Length!=184||o[112]!=17||o[104]!=8||o[107]!=11||BitConverter.ToUInt16(o,176)!=50000||BitConverter.ToInt32(i,84)!=5||i[92]!=8||BitConverter.ToInt32(o,12)!=1)throw new Exception("Voice PASS ABI");var table=new byte[376];Array.Copy(o,0,table,8,184);Array.Copy(i,0,table,192,184);table[32]=123;if(!Matches(table,8,o)||!Matches(table,192,i))throw new Exception("Voice filter counters");table[112]++;if(Matches(table,8,o))throw new Exception("Voice filter verification");}
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr CreateFile(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)]static extern bool DeviceIoControl(IntPtr handle,uint code,byte[] input,int inputSize,byte[] output,int outputSize,out uint returned,IntPtr overlapped);
    [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
}
