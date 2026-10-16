param([string]$EvidenceDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$validator = Join-Path $PSScriptRoot 'assert-identity-package.ps1'
$temporary = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$fixture = Join-Path $temporary ('lumen-identity-metadata-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$source = Get-Content -LiteralPath (Join-Path $root 'packaging/windows/AppxManifest.xml') -Raw
$assets = Join-Path $root 'packaging/windows/Assets'
$assetFiles = @(Get-ChildItem -LiteralPath $assets -Recurse -File)
$cases = @(
    @{name='current-source';accept=$true;change={param($xml)}},
    @{name='formatting-and-comments';accept=$true;change={param($xml) $xml.DocumentElement.AppendChild($xml.CreateComment('owned metadata fixture')) | Out-Null}},
    @{name='wrong-package-name';change={param($xml) $xml.Package.Identity.Name='Bridgehammer.Other'}},
    @{name='wrong-application-id';change={param($xml) $xml.Package.Applications.Application[0].Id='OtherApplication'}},
    @{name='wrong-main-target';change={param($xml) $xml.Package.Applications.Application[0].Executable='other.exe'}},
    @{name='wrong-helper-target';change={param($xml) $xml.Package.Applications.Application[1].Executable='windows-ai\other.exe'}},
    @{name='missing-helper';change={param($xml) $xml.Package.Applications.RemoveChild($xml.Package.Applications.Application[1]) | Out-Null}},
    @{name='external-content-disabled';change={param($xml) $xml.GetElementsByTagName('AllowExternalContent','http://schemas.microsoft.com/appx/manifest/uap/windows10/10')[0].InnerText='false'}},
    @{name='wrong-runtime-behavior';change={param($xml) $xml.Package.Applications.Application[0].SetAttribute('RuntimeBehavior','http://schemas.microsoft.com/appx/manifest/uap/windows10/10','windowsApp')}},
    @{name='wrong-publisher';change={param($xml) $xml.Package.Identity.Publisher='CN=Other'}},
    @{name='wrong-version';change={param($xml) $xml.Package.Identity.Version='0.2.0.0'}},
    @{name='changed-fixed-action-asset';change={param($xml)};changedAsset='Assets/actions.json'},
    @{name='missing-fixed-registration-asset';change={param($xml)};missingAsset='Assets/agentRegistration.json'},
    @{name='extra-payload';change={param($xml)};extra=$true},
    @{name='duplicate-manifest';change={param($xml)};duplicate=$true}
)
$results = @()
$packages = @{}
try {
    foreach ($case in $cases) {
        [xml]$xml = $source
        & $case.change $xml | Out-Null
        $package = Join-Path $fixture ($case.name+'.msix')
        $packages[$case.name] = $package
        $stream = [IO.File]::Open($package,[IO.FileMode]::CreateNew)
        $zip = $null
        try {
            $zip = [IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create)
            $files = @{'AppxManifest.xml'=[Text.Encoding]::UTF8.GetBytes($xml.OuterXml)}
            foreach ($file in $assetFiles) {
                $name = 'Assets/'+$file.FullName.Substring($assets.Length+1).Replace('\','/')
                if ($case.missingAsset -ceq $name) { continue }
                $files[$name] = if ($case.changedAsset -ceq $name) { [Text.Encoding]::UTF8.GetBytes('{"owned":"modified fixture"}') } else { [IO.File]::ReadAllBytes($file.FullName) }
            }
            if ($case.extra) { $files['Assets/other.json'] = [Text.Encoding]::UTF8.GetBytes('{}') }
            foreach ($name in $files.Keys) {
                $entry = $zip.CreateEntry($name); $target = $entry.Open()
                try { $target.Write($files[$name],0,$files[$name].Length) } finally { $target.Dispose() }
            }
            if ($case.duplicate) { $entry = $zip.CreateEntry('AppxManifest.xml'); $target = $entry.Open(); $target.Dispose() }
        } finally { if ($zip) { $zip.Dispose() }; $stream.Dispose() }
        $ErrorActionPreference = 'Continue'
        $output = & powershell.exe -NoProfile -File $validator -PackagePath $package 2>&1
        $code = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        $accepted = $code -eq 0
        $expected = $case.accept -eq $true
        $message = $output | Out-String
        $pattern = if ($case.changedAsset -or $case.missingAsset) { 'Missing or changed fixed identity asset' } elseif ($case.extra) { 'Unexpected identity payload' } elseif ($case.duplicate) { 'Duplicate identity archive entry' } else { 'Actual identity manifest contract differs' }
        $passed = if ($expected) { $accepted -and ($message | ConvertFrom-Json).metadataOnly -eq $true } else { -not $accepted -and $message -match $pattern }
        $results += [ordered]@{name=$case.name;command=@('powershell.exe','-NoProfile','-File',$validator,'-PackagePath',$package);exit=$code;expectedAccepted=$expected;passed=$passed;output=$message;unsignedMetadataFixture=$true}
        Write-Output ($case.name+': exit '+$code+', expected accepted='+$expected)
    }
    $savedThumbprint = $env:LUMEN_SIGN_CERT_SHA1
    $savedSubject = $env:LUMEN_SIGN_CERT_SUBJECT
    try {
        # An absent public selector proves the Sign path stops before any key access.
        $env:LUMEN_SIGN_CERT_SHA1 = $null
        $env:LUMEN_SIGN_CERT_SUBJECT = $null
        $wiring = @(
            @{name='Sign-rejects-other-package-before-owner';action='Sign';package='wrong-package-name';pattern='Actual identity manifest contract differs'},
            @{name='Verify-rejects-other-package-before-signature';action='Verify';package='wrong-package-name';pattern='Actual identity manifest contract differs'},
            @{name='Sign-valid-metadata-still-requires-owner';action='Sign';package='current-source';pattern='An existing owner certificate thumbprint and exact subject are required'},
            @{name='Verify-valid-metadata-still-requires-signature';action='Verify';package='current-source';pattern='Missing or oversized MSIX signature'}
        )
        foreach ($case in $wiring) {
            $command = @('powershell.exe','-NoProfile','-File',(Join-Path $PSScriptRoot 'sign-release.ps1'),'-Action',$case.action,'-Path',$packages[$case.package])
            $ErrorActionPreference = 'Continue'
            $output = & $command[0] $command[1..($command.Length-1)] 2>&1
            $code = $LASTEXITCODE
            $ErrorActionPreference = 'Stop'
            $message = $output | Out-String
            $results += [ordered]@{name=$case.name;command=$command;exit=$code;expectedAccepted=$false;passed=($code -ne 0 -and $message -match $case.pattern);output=$message;unsignedMetadataFixture=$true;signingAttempted=$false}
            Write-Output ($case.name+': expected refusal exit '+$code)
        }
    } finally {
        $env:LUMEN_SIGN_CERT_SHA1 = $savedThumbprint
        $env:LUMEN_SIGN_CERT_SUBJECT = $savedSubject
    }
    if ($EvidenceDirectory) {
        $directory = (Resolve-Path -LiteralPath $EvidenceDirectory).Path
        $results | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $directory 'identity-metadata-results.json')
    }
    $failed = @($results | Where-Object { -not $_.passed })
    if ($failed.Count) { throw ('Identity metadata contract failures: '+(($failed | ForEach-Object { $_.name }) -join ', ')) }
    Write-Output ($results.Count.ToString()+' unsigned metadata/ordering cases passed; no signing, certificate import or trust changes. Signed-MSIX acceptance remains pending.')
} finally {
    $resolved = [IO.Path]::GetFullPath($fixture)
    if (-not $resolved.StartsWith($temporary,[StringComparison]::OrdinalIgnoreCase) -or -not ([IO.Path]::GetFileName($resolved)).StartsWith('lumen-identity-metadata-')) { throw 'Unsafe metadata fixture cleanup.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
