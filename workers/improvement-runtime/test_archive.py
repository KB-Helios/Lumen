import io
import pathlib
import tarfile
import tempfile
import unittest

import canonical_archive


class ArchiveTests(unittest.TestCase):
    def test_outer_archive_ignores_order_ownership_and_timestamps_preserving_blob_bytes(self):
        with tempfile.TemporaryDirectory() as root:
            paths = []
            for variant in (0, 1):
                path = pathlib.Path(root, f"input-{variant}.tar")
                with tarfile.open(path, "w") as archive:
                    for name in (["blob", "manifest.json"] if variant == 0 else ["manifest.json", "blob"]):
                        info = tarfile.TarInfo(name)
                        info.uid = variant * 300
                        info.gid = variant * 400
                        info.mtime = variant * 999
                        info.size = 4
                        archive.addfile(info, io.BytesIO(b"data"))
                output = pathlib.Path(root, f"out-{variant}.tar")
                canonical_archive.normalize(path, output)
                paths.append(output)
            self.assertEqual(paths[0].read_bytes(), paths[1].read_bytes())
            with tarfile.open(paths[0]) as archive:
                self.assertEqual(archive.extractfile("blob").read(), b"data")

    def test_archive_rejects_traversal_and_links_instead_of_extracting(self):
        with tempfile.TemporaryDirectory() as root:
            path = pathlib.Path(root, "input.tar")
            with tarfile.open(path, "w") as archive:
                archive.addfile(tarfile.TarInfo("../escape"), io.BytesIO(b""))
            with self.assertRaises(ValueError):
                canonical_archive.normalize(path, pathlib.Path(root, "output.tar"))


if __name__ == "__main__":
    unittest.main()
