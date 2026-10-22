[CmdletBinding()]
param(
    [string]$TargetIp = '100.93.254.58',
    [string]$ExpectedHostname = 'POS2',
    [string]$ExpectedNodeId = 'nEdQXowQ4t11CNTRL',
    [string]$ExpectedTailnet = 'akcd1998.github',
    [string[]]$ShareName = @(),
    [string]$ResultPath = '',
    [switch]$InspectOnly
)
$ErrorActionPreference = 'Stop'
if (!$ResultPath) { $ResultPath = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'connection-result.json' }
$result = [ordered]@{ checkedAt = [DateTime]::UtcNow.ToString('o'); targetIp = $TargetIp; hostname = $ExpectedHostname; nodeId = $ExpectedNodeId; status = 'checking'; credentialManagerWritten = $false; remoteWrites = 0; shares = @(); connections = @() }
$credential = $null
$passwordPointer = [IntPtr]::Zero
try {
    $tailscalePath = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'Tailscale\tailscale.exe'
    if (!(Test-Path -LiteralPath $tailscalePath)) { throw 'Tailscale is not installed on this computer.' }
    $identity = & $tailscalePath status --json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $identity.BackendState -ne 'Running' -or $identity.CurrentTailnet.Name -ne $ExpectedTailnet) { throw 'Connect to the company Tailscale account first.' }
    $peers = @($identity.Peer.PSObject.Properties.Value | Where-Object { $_.TailscaleIPs -contains $TargetIp })
    if ($peers.Count -ne 1 -or $peers[0].ID -ne $ExpectedNodeId -or $peers[0].HostName -ine $ExpectedHostname -or !$peers[0].Online) { throw 'The target does not match the verified company POS2 device, or is offline.' }
    $tcp = [Net.Sockets.TcpClient]::new()
    try {
        $connect = $tcp.ConnectAsync($TargetIp, 445)
        if (!$connect.Wait(5000) -or !$tcp.Connected) { throw 'SMB port 445 is not reachable over Tailscale.' }
    } finally { $tcp.Dispose() }
    $result.transportVerified = $true
    if (!('SCCRM.PosShareSession' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
namespace SCCRM {
  public sealed class PosShare { public string Name; public string LocalPath; public uint Type; }
  public static class PosShareSession {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct Resource { public uint Scope, Type, DisplayType, Usage; public string LocalName, RemoteName, Comment, Provider; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    private struct Share1 { public string Name; public uint Type; public IntPtr Remark; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    private struct Share2 { public string Name; public uint Type; public IntPtr Remark; public uint Permissions, MaxUses, CurrentUses; public string Path; public IntPtr Password; }
    [DllImport("mpr.dll", CharSet=CharSet.Unicode, EntryPoint="WNetAddConnection2W")]
    private static extern int Add(ref Resource resource, IntPtr password, string user, uint flags);
    [DllImport("Netapi32.dll", CharSet=CharSet.Unicode)]
    private static extern int NetShareEnum(string server, int level, out IntPtr buffer, int maximum, out int read, out int total, ref int resume);
    [DllImport("Netapi32.dll")] private static extern int NetApiBufferFree(IntPtr buffer);
    public static int Connect(string remote, string user, IntPtr password) {
      var resource = new Resource { RemoteName=remote, Type=0 };
      // No drive letter, persistent profile, credential-manager or interactive flags.
      return Add(ref resource, password, user, 0);
    }
    private static PosShare[] Enumerate(string server, int level, out int error) {
      var list=new List<PosShare>(); int resume=0;
      do {
        IntPtr buffer=IntPtr.Zero; int read,total;
        error=NetShareEnum(server,level,out buffer,-1,out read,out total,ref resume);
        try {
          if(error!=0 && error!=234) return new PosShare[0];
          Type type=level==2?typeof(Share2):typeof(Share1); int size=Marshal.SizeOf(type);
          for(int i=0;i<read;i++) {
            IntPtr row=IntPtr.Add(buffer,i*size);
            if(level==2) { var share=(Share2)Marshal.PtrToStructure(row,type); list.Add(new PosShare{Name=share.Name,Type=share.Type,LocalPath=share.Path}); }
            else { var share=(Share1)Marshal.PtrToStructure(row,type); list.Add(new PosShare{Name=share.Name,Type=share.Type}); }
          }
        } finally { if(buffer!=IntPtr.Zero) NetApiBufferFree(buffer); }
      } while(error==234);
      return list.ToArray();
    }
    public static PosShare[] Shares(string server) {
      int error; var shares=Enumerate(server,2,out error);
      if(error==5) shares=Enumerate(server,1,out error);
      if(error!=0) throw new InvalidOperationException("Share enumeration failed (Windows code "+error+").");
      return shares;
    }
  }
}
'@
    }
    if ($InspectOnly) {
        $result.status = 'ready_for_credentials'
        $result | ConvertTo-Json -Depth 6
        return
    }
    # A PowerShell 7 parent may pass its module path to Windows PowerShell 5.1.
    # Select this process's built-in credential module rather than autoloading
    # an incompatible copy from the parent process. No machine setting changes.
    Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
    $credential = Microsoft.PowerShell.Security\Get-Credential -UserName ($ExpectedHostname + '\') -Message ('Connect to ' + $ExpectedHostname + ' (' + $TargetIp + '). Enter the Windows account created on that POS. The password is not saved to a file or sent to chat.')
    if ($null -eq $credential) { $result.status = 'cancelled'; return }
    $loginName = $credential.UserName
    if ($loginName.StartsWith('.\')) { $loginName = $ExpectedHostname + $loginName.Substring(1) }
    if (!$loginName.Contains('\') -and !$loginName.Contains('@')) { $loginName = $ExpectedHostname + '\' + $loginName }
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($credential.Password)
    $code = [SCCRM.PosShareSession]::Connect(('\\' + $TargetIp + '\IPC$'), $loginName, $passwordPointer)
    if ($code -eq 1219) { throw 'Windows already has a connection to this POS with another account (1219). Existing connections have been left unchanged.' }
    if ($code -ne 0) { throw ('SMB login failed (Windows code ' + $code + '). Check the POS account and its share permissions.') }
    $result.authenticated = $true
    $shares = @([SCCRM.PosShareSession]::Shares(('\\' + $TargetIp)) | Where-Object { ($_.Type -band 255) -eq 0 })
    $result.shares = @($shares | ForEach-Object { [ordered]@{ name = $_.Name; localPath = $_.LocalPath } })
    if ($ShareName.Count) { $selected = @($shares | Where-Object { $ShareName -contains $_.Name }) }
    else { $selected = @($shares | Where-Object { $_.Name -in @('C','D','C$','D$') } | Sort-Object @{Expression={ $_.Name.EndsWith('$') }},Name) }
    $connections = @()
    foreach ($share in $selected) {
        $remote = '\\' + $TargetIp + '\' + $share.Name
        $shareCode = [SCCRM.PosShareSession]::Connect($remote, $loginName, $passwordPointer)
        $readable = $false
        if ($shareCode -eq 0) {
            try { $null = Get-Item -LiteralPath $remote; $readable = $true } catch { }
        }
        $connections += [ordered]@{ share = $share.Name; remotePath = $remote; localPath = $share.LocalPath; readable = $readable; windowsCode = $shareCode }
    }
    $result.connections = $connections
    $result.status = if (@($connections | Where-Object { $_.readable }).Count) { 'connected' } else { 'authenticated_no_accessible_drive_share' }
} catch {
    $result.status = 'failed'
    # Our diagnostic messages include no entered credential values.
    $result.message = if ($_.Exception -is [System.Management.Automation.PipelineStoppedException]) { 'Cancelled.' } else { $_.Exception.Message }
    if ($InspectOnly) { $result | ConvertTo-Json -Depth 6; exit 1 }
} finally {
    if ($passwordPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($passwordPointer) }
    if ($null -ne $credential) { $credential.Password.Dispose(); $credential = $null }
    $loginName = $null
    if (!$InspectOnly) {
        [IO.File]::WriteAllText([IO.Path]::GetFullPath($ResultPath), ($result | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
        Add-Type -AssemblyName System.Windows.Forms
        $message = if ($result.status -eq 'connected') { 'Connected to POS2. The existing account permissions apply. Password was not saved. You can return to the chat.' }
            elseif ($result.status -eq 'authenticated_no_accessible_drive_share') { 'Login succeeded, but no accessible C/D drive share was found. Creating a Windows account alone does not share folders. Return to the chat to finish the share setup.' }
            elseif ($result.status -eq 'cancelled') { 'Connection cancelled.' }
            else { 'Connection did not finish: ' + $result.message }
        $null = [Windows.Forms.MessageBox]::Show($message, 'SCCRM - POS2 file connection')
    }
}
