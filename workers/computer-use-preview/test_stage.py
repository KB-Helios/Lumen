"""Staging inventory rejects tampered, missing and unexpected runtime files."""
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent


class StageTests(unittest.TestCase):
    def test_runtime_inventory_detects_corruption_missing_and_extra_files(self):
        (ROOT / '.build').mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='inventory-test-', dir=ROOT / '.build') as directory:
            target = Path(directory)
            script = target / 'test.ts'
            stage = ROOT.parent.parent / 'scripts/stage-computer-use.ts'
            script.write_text(f'''import {{generateRuntimeInventory, verifyRuntimeInventory}} from {json.dumps(stage.as_uri())};
import {{mkdir,writeFile,rm}} from 'node:fs/promises';
import {{join}} from 'node:path';
const root={json.dumps(str(target))};
const native=join(root,'computer-use-runtime','cua_driver','cua_driver_sdk.dll');
await mkdir(join(root,'computer-use-runtime','cua_driver'),{{recursive:true}});
await writeFile(join(root,'lumen-computer-use-x86_64-pc-windows-msvc.exe'),'fixed executor');
await writeFile(native,'fixed native resource');
const inventory=await generateRuntimeInventory(root,'test-build');
if (!await verifyRuntimeInventory(root,inventory,'test-build')) throw new Error('Fresh inventory refused');
if (await verifyRuntimeInventory(root,inventory,'another-build')) throw new Error('Old build inventory accepted');
await writeFile(native,'modified native resource');
if (await verifyRuntimeInventory(root,inventory,'test-build')) throw new Error('Corruption accepted');
await writeFile(native,'fixed native resource');
await writeFile(join(root,'computer-use-runtime','unexpected.dll'),'unexpected');
if (await verifyRuntimeInventory(root,inventory,'test-build')) throw new Error('Unexpected file accepted');
await rm(join(root,'computer-use-runtime','unexpected.dll'));
await rm(native);
if (await verifyRuntimeInventory(root,inventory,'test-build')) throw new Error('Missing native resource accepted');
console.log('inventory checks passed');
''', encoding='utf-8')
            result = subprocess.run(['bun', str(script)], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('inventory checks passed', result.stdout)


if __name__ == '__main__':
    unittest.main()
