param(
    [Parameter(Mandatory)][ValidateSet('Preflight','Inspect','Sign','Verify')][string]$Action,
    [string]$Path
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-SigningTool {
    $tool = $env:LUMEN_SIGNTOOL
    if (-not $tool) {
        $sdk = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
        $tool = Get-ChildItem -LiteralPath $sdk -Directory | Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName 'x64/signtool.exe' } |
            Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    }
    if (-not $tool -or -not [IO.Path]::IsPathRooted($tool) -or -not (Test-Path -LiteralPath $tool -PathType Leaf)) { throw 'Installed Windows SDK x64 SignTool is required.' }
    return $tool
}

function Assert-Owner {
    if ($env:LUMEN_SIGN_CERT_SHA1 -cnotmatch '^[A-F0-9]{40}$' -or -not $env:LUMEN_SIGN_CERT_SUBJECT) { throw 'An existing owner certificate thumbprint and exact subject are required.' }
    if ($env:LUMEN_SIGN_CERT_STORE -notin @('CurrentUser','LocalMachine')) { throw 'LUMEN_SIGN_CERT_STORE must explicitly select CurrentUser or LocalMachine (My).' }
    $timestamp = $null
    if (-not [Uri]::TryCreate($env:LUMEN_SIGN_TIMESTAMP_URL,[UriKind]::Absolute,[ref]$timestamp) -or $timestamp.Scheme -notin @('http','https') -or $timestamp.UserInfo -or $timestamp.Fragment) { throw 'An owner-approved RFC3161 HTTP(S) timestamp URL is required.' }
    $store = [Security.Cryptography.X509Certificates.X509Store]::new('My', [Security.Cryptography.X509Certificates.StoreLocation]$env:LUMEN_SIGN_CERT_STORE)
    try {
        $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
        $certs = @($store.Certificates | Where-Object { $_.Thumbprint -ceq $env:LUMEN_SIGN_CERT_SHA1 })
        if ($certs.Count -ne 1) { throw 'Selected existing certificate is unavailable in the chosen My store.' }
        $cert = $certs[0]
        $eku = @($cert.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' } | ForEach-Object { $_.EnhancedKeyUsages } | Where-Object { $_.Value -eq '1.3.6.1.5.5.7.3.3' })
        if ($cert.Subject -cne $env:LUMEN_SIGN_CERT_SUBJECT -or -not $cert.HasPrivateKey -or $cert.NotBefore -gt [DateTime]::Now -or $cert.NotAfter -le [DateTime]::Now -or $eku.Count -ne 1) { throw 'Selected identity must match its exact subject, current validity, private-key availability and code-signing EKU.' }
        $chain = [Security.Cryptography.X509Certificates.X509Chain]::new()
        try { if (-not $chain.Build($cert)) { throw 'Selected signing identity does not validate against existing Windows trust.' } }
        finally { $chain.Dispose() }
    } finally { $store.Close() }
}

function Get-EmbeddedCms([string]$File) {
    if ([IO.Path]::GetExtension($File) -eq '.msix') {
        $zip = [IO.Compression.ZipFile]::OpenRead($File)
        try {
            $entry = $zip.GetEntry('AppxSignature.p7x')
            if (-not $entry -or $entry.Length -gt 1048576) { throw 'Missing or oversized MSIX signature.' }
            $stream = $entry.Open(); $memory = [IO.MemoryStream]::new()
            try { $stream.CopyTo($memory); $bytes = $memory.ToArray() } finally { $stream.Dispose(); $memory.Dispose() }
            if ([Text.Encoding]::ASCII.GetString($bytes,0,4) -ne 'PKCX') { throw 'Invalid MSIX signature container.' }
            return ,([byte[]]$bytes[4..($bytes.Length-1)])
        } finally { $zip.Dispose() }
    }
    $bytes = [IO.File]::ReadAllBytes($File)
    if ($bytes.Length -lt 64 -or $bytes[0] -ne 77 -or $bytes[1] -ne 90) { throw 'Expected a PE image.' }
    $pe = [BitConverter]::ToUInt32($bytes,60)
    if ($pe -gt $bytes.Length-152 -or [BitConverter]::ToUInt32($bytes,$pe) -ne 17744) { throw 'Invalid PE header.' }
    $optional = $pe+24
    $magic = [BitConverter]::ToUInt16($bytes,$optional)
    $security = if ($magic -eq 523) { $optional+144 } elseif ($magic -eq 267) { $optional+128 } else { throw 'Invalid PE optional header.' }
    $offset = [BitConverter]::ToUInt32($bytes,$security); $size = [BitConverter]::ToUInt32($bytes,$security+4)
    if ($offset -eq 0 -and $size -eq 0) { return $null }
    if ($size -lt 8 -or $offset -gt $bytes.Length-$size -or $size -gt 1048576) { throw 'Invalid PE signature directory.' }
    $length = [BitConverter]::ToUInt32($bytes,$offset)
    if ($length -lt 8 -or $length -gt $size -or [BitConverter]::ToUInt16($bytes,$offset+6) -ne 2) { throw 'Invalid Authenticode container.' }
    if ($size -gt ([Math]::Ceiling($length/8)*8)) { throw 'Multiple PE certificate-table entries are not supported by the release identity policy.' }
    return ,([byte[]]$bytes[($offset+8)..($offset+$length-1)])
}

function Read-DerValue([byte[]]$Bytes,[int]$Position) {
    if ($Position -lt 0 -or $Position -ge $Bytes.Length-1) { throw 'Truncated signature DER.' }
    $tag = $Bytes[$Position]; $length = [int]$Bytes[$Position+1]; $start = $Position+2
    if ($length -band 128) {
        $count = $length -band 127
        if ($count -lt 1 -or $count -gt 4 -or $start+$count -gt $Bytes.Length) { throw 'Invalid signature DER length.' }
        $length = 0
        for ($i=0;$i -lt $count;$i++) { $length = $length*256+$Bytes[$start+$i] }
        $start += $count
    }
    if ($length -lt 0 -or $length -gt $Bytes.Length-$start) { throw 'Signature DER exceeds its container.' }
    return @{tag=$tag;start=$start;end=$start+$length;length=$length}
}

function Get-CmsPolicy($Cms,[int]$Depth=0) {
    if ($Depth -gt 8 -or $Cms.SignerInfos.Count -ne 1 -or $Cms.ContentInfo.ContentType.Value -ne '1.3.6.1.4.1.311.2.1.4') { throw 'Unsupported or ambiguous Authenticode signer/content.' }
    $signer = $Cms.SignerInfos[0]
    $content = $Cms.ContentInfo.Content
    $container = Read-DerValue $content 0
    $data = Read-DerValue $content $container.start
    $digest = Read-DerValue $content $data.end
    $algorithm = Read-DerValue $content $digest.start
    $oid = Read-DerValue $content $algorithm.start
    if ($container.tag -ne 48 -or $digest.tag -ne 48 -or $algorithm.tag -ne 48 -or $oid.tag -ne 6 -or $oid.length -ne 9) { throw 'Invalid Authenticode file-digest content.' }
    $fileSha256 = [BitConverter]::ToString($content[$oid.start..($oid.end-1)]) -ceq '60-86-48-01-65-03-04-02-01'
    $result = @{sha256=($fileSha256 -and $signer.DigestAlgorithm.Value -eq '2.16.840.1.101.3.4.2.1');timestamped=(@($signer.UnsignedAttributes | Where-Object { $_.Oid.Value -in @('1.3.6.1.4.1.311.3.3.1','1.2.840.113549.1.9.6') }).Count -gt 0);signers=@(@{subject=$signer.Certificate.Subject;thumbprint=$signer.Certificate.Thumbprint})}
    foreach ($attribute in $signer.UnsignedAttributes) {
        if ($attribute.Oid.Value -ne '1.3.6.1.4.1.311.2.4.1') { continue }
        foreach ($value in $attribute.Values) {
            $nested = [Security.Cryptography.Pkcs.SignedCms]::new(); $nested.Decode($value.RawData)
            $policy = Get-CmsPolicy $nested ($Depth+1)
            $result.sha256 = $result.sha256 -and $policy.sha256
            $result.timestamped = $result.timestamped -and $policy.timestamped
            $result.signers += $policy.signers
        }
    }
    return $result
}

function Get-SignatureReport([string]$File,[switch]$Verify) {
    $identity = if ([IO.Path]::GetExtension($File) -eq '.msix') { Get-IdentityMetadata $File } else { $null }
    $cmsBytes = Get-EmbeddedCms $File
    if (-not $cmsBytes) { return @{status='NotSigned';subject='';thumbprint='';sha256=$false;timestamped=$false} }
    $cms = [Security.Cryptography.Pkcs.SignedCms]::new(); $cms.Decode($cmsBytes)
    $policy = Get-CmsPolicy $cms
    $signer = $cms.SignerInfos[0]
    if ($Verify) {
        $tool = Get-SigningTool
        $verification = & $tool verify /pa /all /tw /v $File 2>&1
        if ($LASTEXITCODE -ne 0) { $verification | ForEach-Object { [Console]::Error.WriteLine($_) }; throw 'SignTool rejected signature/trust/timestamp (warnings fail).' }
    }
    $report = @{status=$(if ($Verify) {'Valid'} else {'Unverified'});subject=$signer.Certificate.Subject;thumbprint=$signer.Certificate.Thumbprint;sha256=$policy.sha256;timestamped=$policy.timestamped;signers=$policy.signers}
    if ($identity) {
        $report.packageName = $identity.packageName
        $report.packageVersion = $identity.packageVersion
        $report.packagePublisher = $identity.packagePublisher
    }
    return $report
}

function Get-IdentityMetadata([string]$File) {
    $metadata = & powershell.exe -NoProfile -File (Join-Path $PSScriptRoot 'assert-identity-package.ps1') -PackagePath $File
    if ($LASTEXITCODE -ne 0) { throw 'Actual Lumen identity metadata contract validation failed.' }
    return $metadata | ConvertFrom-Json
}

if ($Action -eq 'Preflight') {
    $null = Get-SigningTool; Assert-Owner
    @{status='ready';subject=$env:LUMEN_SIGN_CERT_SUBJECT;thumbprint=$env:LUMEN_SIGN_CERT_SHA1} | ConvertTo-Json -Compress
    exit 0
}
$file = (Resolve-Path -LiteralPath $Path).Path
if ((Get-Item -LiteralPath $file).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing to sign/verify a reparse point.' }
if ($Action -eq 'Sign') {
    if ([IO.Path]::GetExtension($file) -eq '.msix') { $null = Get-IdentityMetadata $file }
    Assert-Owner; $tool = Get-SigningTool
    $arguments = @('sign','/fd','SHA256','/sha1',$env:LUMEN_SIGN_CERT_SHA1,'/s','My','/tr',$env:LUMEN_SIGN_TIMESTAMP_URL,'/td','SHA256')
    if ($env:LUMEN_SIGN_CERT_STORE -eq 'LocalMachine') { $arguments += '/sm' }
    $output = & $tool @arguments $file 2>&1
    if ($LASTEXITCODE -ne 0) { $output | ForEach-Object { [Console]::Error.WriteLine($_) }; throw 'SignTool did not complete signing and timestamping.' }
}
$report = Get-SignatureReport $file -Verify:($Action -ne 'Inspect')
if ($Action -ne 'Inspect' -and ($report.status -ne 'Valid' -or -not $report.sha256 -or -not $report.timestamped)) { throw 'A trusted SHA256 timestamped signature is required.' }
if ($Action -eq 'Sign' -and ($report.subject -cne $env:LUMEN_SIGN_CERT_SUBJECT -or $report.thumbprint -cne $env:LUMEN_SIGN_CERT_SHA1)) { throw 'Signed output does not match the selected owner identity.' }
$report | ConvertTo-Json -Depth 6 -Compress
