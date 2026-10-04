# Optional Windows identity

The existing NSIS installer remains the default distribution. This optional sparse MSIX adds package identity to the installed `lumen.exe` and `windows-ai/lumen-windows-ai.exe`. It is required for identity-dependent Windows AI and App Actions APIs. Identity alone does not grant restricted model access, install preview frameworks, prepare models, or register an Agent Launcher.

Package identity is `Bridgehammer.Lumen`, publisher `CN=Bridgehammer`. Application IDs are `Lumen` and `WindowsAiHelper`; both fusion manifests are embedded at build time. The optional identity declares `systemAIModels` and depends on Microsoft's signed `Microsoft.WindowsAppRuntime.2-experimentalF` framework, minimum version `2.5.4.0`; that preview runtime must already be installed under its applicable terms before registration. The helper verifies the actual framework dependency rather than treating a bootstrap no-op as readiness. Changing the publisher requires changing all three manifests and using that publisher's existing signing certificate. No script creates certificates, changes certificate trust, enables Developer Mode, changes browser flags, or installs frameworks.

From a developer PowerShell at the repository root:

```powershell
rtk proxy powershell -NoProfile -File packaging/windows/Build-Identity.ps1 -ValidateOnly
rtk proxy powershell -NoProfile -File packaging/windows/Build-Identity.ps1
rtk proxy powershell -NoProfile -File packaging/windows/Sign-Identity.ps1 -PackagePath packaging/windows/output/Lumen.Identity.msix -CertificateThumbprint <existing-certificate-thumbprint>
rtk proxy powershell -NoProfile -File packaging/windows/Register-Identity.ps1 -PackagePath packaging/windows/output/Lumen.Identity.msix -InstallDirectory <actual-Lumen-install-directory>
```

The build uses the installed Windows SDK MakeAppx tool and the documented `/nv` switch because executable locations are external. Signing uses an existing CurrentUser/My certificate; registration requires a signature already trusted by Windows. Assets are included inside the identity package and also bundled with NSIS. Restart Lumen and refresh Diagnostics after registration. Verify package identity for both main and helper processes before interpreting a Windows API as usable.

The main fusion manifest preserves Tauri's Common Controls v6 dependency. The .NET helper embeds `helper.manifest` directly so its package application identity has a single source. Identity validation rejects a main manifest that drops the dependency. Changing the publisher also requires updating the helper's fixed identity validation in `WindowsHost.cs`.

App Actions declares a URI action with `agentName` and `prompt` Text entities. Its only destination is `lumen:agent?agentName=lumen.browser&prompt=...`. URI launches populate a task draft that the user must review and explicitly start. Agent Launcher registration is dynamic and opt-in through Lumen; the sparse manifest deliberately contains no static `com.microsoft.windows.ai.agentInfo` extension. Native registration is verified by a fresh Windows catalogue read.

To remove the optional identity for the current user, first unregister Lumen's agent in the app, close Lumen, then run:

```powershell
rtk proxy powershell -NoProfile -File packaging/windows/Unregister-Identity.ps1
```

References: [external-location identity](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/grant-identity-to-nonpackaged-apps), [fusion manifests](https://learn.microsoft.com/en-us/windows/win32/sbscs/application-manifests), [App Action package declarations](https://learn.microsoft.com/en-us/windows/ai/app-actions/actions-provider-manifest), [Agent Launchers](https://learn.microsoft.com/en-us/windows/ai/agent-launchers/agents-get-started).
