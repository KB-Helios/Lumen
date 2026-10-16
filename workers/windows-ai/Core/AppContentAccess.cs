namespace Lumen.WindowsAi;

internal static class AppContentAccess
{
    // Stable search needs its own Microsoft-issued activation contract, not the language token.
    public const string ReasonCode = "app_content_access_not_provisioned";
    public static void Require() => throw new HelperFault(ReasonCode);
}
