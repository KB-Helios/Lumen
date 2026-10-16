param([Parameter(Mandatory)][string]$PackagePath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Assert-RegularPath([string]$Path,[switch]$Directory) {
    $absolute = [IO.Path]::GetFullPath($Path)
    for ($ancestor=$absolute;$ancestor;$ancestor=[IO.Path]::GetDirectoryName($ancestor)) {
        $item = Get-Item -LiteralPath $ancestor -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Identity contract refuses reparse paths.' }
        if ($ancestor -eq $absolute -and $item.PSIsContainer -ne [bool]$Directory) { throw 'Identity contract requires a regular file/directory.' }
    }
}

function Read-Manifest([IO.Stream]$Stream) {
    $settings = [Xml.XmlReaderSettings]::new()
    $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
    $settings.XmlResolver = $null
    $settings.CloseInput = $true
    $settings.MaxCharactersInDocument = 1048576
    $reader = [Xml.XmlReader]::Create($Stream,$settings)
    try {
        $document = [Xml.XmlDocument]::new(); $document.XmlResolver = $null
        $document.Load($reader)
        return ,$document
    } finally { $reader.Dispose() }
}

function Contract-Node([Xml.XmlNode]$Node,[int]$Depth=0) {
    if ($Depth -gt 32) { throw 'Identity manifest exceeds its structural bound.' }
    if ($Node.NodeType -ne [Xml.XmlNodeType]::Element) { return [ordered]@{text=$Node.Value} }
    $attributes = @($Node.Attributes | Where-Object { $_.NamespaceURI -ne 'http://www.w3.org/2000/xmlns/' } | Sort-Object NamespaceURI,LocalName | ForEach-Object {
        [ordered]@{namespace=$_.NamespaceURI;name=$_.LocalName;value=$_.Value}
    })
    $children = @($Node.ChildNodes | Where-Object { $_.NodeType -in @([Xml.XmlNodeType]::Element,[Xml.XmlNodeType]::Text,[Xml.XmlNodeType]::CDATA) } | ForEach-Object { Contract-Node $_ ($Depth+1) })
    return [ordered]@{namespace=$Node.NamespaceURI;name=$Node.LocalName;attributes=$attributes;children=$children}
}

function Sha256-Stream([IO.Stream]$Stream) {
    $digest = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($digest.ComputeHash($Stream)).Replace('-','').ToLowerInvariant() }
    finally { $digest.Dispose(); $Stream.Dispose() }
}

$packaging = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../packaging/windows')).Path
$sourceValidation = & powershell.exe -NoProfile -File (Join-Path $packaging 'Build-Identity.ps1') -ValidateOnly
if ($LASTEXITCODE -ne 0) { throw ('Invalid source identity contract: '+$sourceValidation) }
$source = Read-Manifest ([IO.File]::OpenRead((Join-Path $packaging 'AppxManifest.xml')))
foreach ($name in @('lumen.manifest','helper.manifest')) {
    $fusion = Read-Manifest ([IO.File]::OpenRead((Join-Path $packaging $name)))
    if ($fusion.assembly.msix.publisher -cne $source.Package.Identity.Publisher -or $fusion.assembly.assemblyIdentity.version -cne $source.Package.Identity.Version) { throw 'Fusion identity publisher/version mismatch; rebuild both executables before signing.' }
}
$expected = [ordered]@{}
$assets = Join-Path $packaging 'Assets'
function Source-Assets([string]$Directory) {
    Assert-RegularPath $Directory -Directory
    foreach ($item in Get-ChildItem -LiteralPath $Directory -Force | Sort-Object Name) {
        if ($item.PSIsContainer) { Source-Assets $item.FullName }
        else {
            Assert-RegularPath $item.FullName
            $name = 'Assets/'+$item.FullName.Substring($assets.Length+1).Replace('\','/')
            $expected[$name] = Sha256-Stream ([IO.File]::OpenRead($item.FullName))
        }
    }
}
Source-Assets $assets
$file = (Resolve-Path -LiteralPath $PackagePath).Path
Assert-RegularPath $file
$zip = [IO.Compression.ZipFile]::OpenRead($file)
try {
    $entries = @{}
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    if ($zip.Entries.Count -gt 10000) { throw 'Identity archive exceeds its entry bound.' }
    foreach ($entry in $zip.Entries) {
        $name = $entry.FullName
        $unsafeComponent = @($name.TrimEnd('/').Split('/') | Where-Object { -not $_ -or $_ -in @('.','..') -or $_.Contains(':') }).Count -gt 0
        if ($name.Contains('\') -or $name.StartsWith('/') -or $unsafeComponent) { throw 'Unsafe identity archive path.' }
        if (-not $seen.Add($name)) { throw 'Duplicate identity archive entry.' }
        if ($name.EndsWith('/')) { continue }
        if ($entry.Length -gt 4194304) { throw 'Identity archive entry exceeds its size bound.' }
        if ($name -cne 'AppxManifest.xml' -and $expected.Keys -cnotcontains $name -and $name -cnotin @('AppxBlockMap.xml','[Content_Types].xml','AppxSignature.p7x')) { throw ('Unexpected identity payload: '+$name) }
        $stream = $entry.Open()
        try { if ($stream.ReadByte() -eq 77 -and $stream.ReadByte() -eq 90) { throw 'Sparse identity must reference external executables, not contain PE payloads.' } }
        finally { $stream.Dispose() }
        $entries[$name] = $entry
    }
    if (-not $entries.ContainsKey('AppxManifest.xml')) { throw 'Missing actual identity manifest.' }
    $manifest = Read-Manifest ($entries['AppxManifest.xml'].Open())
    $actualContract = Contract-Node $manifest.DocumentElement | ConvertTo-Json -Depth 100 -Compress
    $sourceContract = Contract-Node $source.DocumentElement | ConvertTo-Json -Depth 100 -Compress
    if ($actualContract -cne $sourceContract) { throw 'Actual identity manifest contract differs from the validated Lumen source (identity, sparse content, applications or declarations).' }
    foreach ($name in $expected.Keys) {
        if (-not $entries.ContainsKey($name) -or (Sha256-Stream ($entries[$name].Open())) -cne $expected[$name]) { throw ('Missing or changed fixed identity asset: '+$name) }
    }
    # This is metadata evidence only; the caller must still establish the real signature/trust.
    [ordered]@{metadataOnly=$true;packageName=[string]$manifest.Package.Identity.Name;packageVersion=[string]$manifest.Package.Identity.Version;packagePublisher=[string]$manifest.Package.Identity.Publisher;fixedAssets=$expected} | ConvertTo-Json -Depth 6 -Compress
} finally { $zip.Dispose() }
