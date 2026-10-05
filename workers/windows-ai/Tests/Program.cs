using Lumen.WindowsAi;

if (args.Length == 2)
{
    using var file = File.OpenRead(args[0]);
    using var pe = new System.Reflection.PortableExecutable.PEReader(file);
    var metadata = System.Reflection.Metadata.PEReaderExtensions.GetMetadataReader(pe);
    foreach (var handle in metadata.TypeDefinitions)
    {
        var type = metadata.GetTypeDefinition(handle);
        if (metadata.GetString(type.Name) != args[1]) continue;
        foreach (var field in type.GetFields()) Console.WriteLine(metadata.GetString(metadata.GetFieldDefinition(field).Name));
    }
    return 0;
}

var tests = new (string, Action)[]
{
    ("request ids reject spaces and protocol delimiters", () => Check(!Protocol.IsRequestId("injected\nmessage"))),
    ("request ids reject empty and overlong values", () => Check(!Protocol.IsRequestId("") && !Protocol.IsRequestId(new string('a', 81)))),
    ("request ids permit the shared bounded ASCII alphabet", () => Check(Protocol.IsRequestId("native-aion:42._ready"))),
    ("text limits count UTF-8 bytes", () => Check(!Protocol.IsBoundedText(new string('å', 32769), 65536))),
    ("text permits the exact UTF-8 boundary", () => Check(Protocol.IsBoundedText(new string('å', 32768), 65536))),
    ("request parser rejects duplicate protocol fields", () => Reject(() => Protocol.Parse("{\"id\":\"a\",\"id\":\"b\",\"operation\":\"status\",\"payload\":{}}"))),
    ("request parser rejects arbitrary process operations", () => Reject(() => Protocol.Parse("{\"id\":\"a\",\"operation\":\"launch\",\"payload\":{}}"))),
    ("request parser rejects non-object payloads", () => Reject(() => Protocol.Parse("{\"id\":\"a\",\"operation\":\"status\",\"payload\":[]}"))),
    ("native cancellation cancels an actual async wait", () => {
        using var registry = new RequestRegistry();
        var source = registry.Add("active");
        var operation = Task.Delay(TimeSpan.FromMinutes(1), source.Token);
        Check(registry.Cancel("active"));
        try { operation.GetAwaiter().GetResult(); throw new Exception(); } catch (TaskCanceledException) { }
        registry.Remove("active"); Check(!registry.Cancel("active"));
    }),
};
var failures = 0;
foreach (var (name, test) in tests)
{
    try { test(); Console.WriteLine($"PASS {name}"); }
    catch { failures++; Console.WriteLine($"FAIL {name}"); }
}
Console.WriteLine($"{tests.Length - failures}/{tests.Length} tests passed.");
return failures == 0 ? 0 : 1;

static void Check(bool condition) { if (!condition) throw new InvalidOperationException("Assertion failed"); }
static void Reject(Action action) { try { action(); } catch (HelperFault) { return; } throw new InvalidOperationException("Expected rejection"); }
