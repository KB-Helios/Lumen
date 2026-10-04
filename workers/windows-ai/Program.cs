using Lumen.WindowsAi;

Console.InputEncoding = new System.Text.UTF8Encoding(false, true);
Console.OutputEncoding = new System.Text.UTF8Encoding(false);
try
{
    using var server = new HelperServer();
    await server.Run();
    return 0;
}
catch
{
    // Rust reports process failures. Never expose raw exception text, prompts,
    // provider diagnostics, personal file paths, or access tokens on either pipe.
    return 1;
}
